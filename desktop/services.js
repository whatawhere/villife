const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SOUNDCLOUD = "https://api-v2.soundcloud.com";
const LRCLIB = "https://lrclib.net/api";

let clientId = "39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ";
let refreshing = null;

async function httpText(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Request to ${url} failed with ${response.status}`);
  return response.text();
}

async function httpJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`Request to ${url} failed with ${response.status}`);
  return response.json();
}

async function refreshClientId() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const home = await httpText("https://soundcloud.com/");
      const scripts = [...home.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].slice(0, 12);
      for (const match of scripts) {
        try {
          const script = await httpText(match[1]);
          const found = script.match(/client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
          if (found) {
            clientId = found[1];
            return true;
          }
        } catch {
          continue;
        }
      }
    } catch {
      return false;
    }
    return false;
  })();
  const result = await refreshing;
  refreshing = null;
  return result;
}

async function scGet(url) {
  const separator = url.includes("?") ? "&" : "?";
  for (let attempt = 0; attempt < 2; attempt++) {
    let response;
    try {
      response = await fetch(url + separator + "client_id=" + clientId, {
        headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
        redirect: "follow"
      });
    } catch (error) {
      if (attempt === 0 && (await refreshClientId())) continue;
      throw error;
    }
    if ((response.status === 401 || response.status === 403) && attempt === 0) {
      if (await refreshClientId()) continue;
    }
    if (!response.ok) throw new Error(`SoundCloud request failed with ${response.status}`);
    return response.text();
  }
  throw new Error("SoundCloud request failed");
}

async function scJson(url) {
  return JSON.parse(await scGet(url));
}

function artworkUrl(value) {
  if (!value) return "";
  return value.replace("-large.", "-t500x500.");
}

function mapTrack(data) {
  const user = data.user || null;
  let artwork = data.artwork_url || "";
  if (!artwork && user && user.avatar_url) artwork = user.avatar_url;
  const duration = data.full_duration > 0 ? data.full_duration : data.duration || 0;
  return {
    id: "sc:" + (data.id || 0),
    title: data.title || "",
    artist: user && user.username ? user.username : "",
    artistId: user && user.id ? "sc:" + user.id : "",
    avatar: user && user.avatar_url ? user.avatar_url : "",
    artwork: artworkUrl(artwork),
    duration: Math.round(duration / 1000),
    preview: "",
    stream: "/api/stream?id=" + encodeURIComponent("sc:" + (data.id || 0)),
    source: "soundcloud"
  };
}

async function search(term) {
  const data = await scJson(`${SOUNDCLOUD}/search/tracks?q=${encodeURIComponent(term)}&limit=24`);
  const collection = data && data.collection ? data.collection : [];
  return collection
    .filter(item => item && item.streamable !== false)
    .map(mapTrack);
}

async function searchPlaylists(term) {
  const data = await scJson(`${SOUNDCLOUD}/search/playlists?q=${encodeURIComponent(term)}&limit=12`);
  const collection = data && data.collection ? data.collection : [];
  const playlists = [];
  for (const playlist of collection) {
    if (!playlist) continue;
    const user = playlist.user || null;
    const tracks = playlist.tracks || [];
    let artwork = playlist.artwork_url || "";
    if (!artwork && tracks.length && tracks[0] && tracks[0].artwork_url) artwork = tracks[0].artwork_url;
    if (!artwork && user && user.avatar_url) artwork = user.avatar_url;
    if (artwork) {
      artwork = artwork.replace("-large.", "-t500x500.");
      artwork = artwork.replace("i1.sndcdn.com", "i2.sndcdn.com");
    }
    const isAlbum = playlist.is_album === true || String(playlist.set_type || "").toLowerCase() === "album";
    let date = playlist.release_date || "";
    if (!date) date = playlist.created_at || "";
    playlists.push({
      id: "sc-set:" + (playlist.id || 0),
      title: playlist.title || "",
      artist: user && user.username ? user.username : "",
      artistId: user && user.id ? "sc:" + user.id : "",
      artwork,
      trackCount: playlist.track_count || 0,
      year: date.length >= 4 ? date.substring(0, 4) : "",
      type: isAlbum ? "album" : "playlist"
    });
  }
  return playlists;
}

function missingMetadata(track) {
  return !track.title || !track.artist || !track.artwork || track.duration <= 0;
}

async function playlistTracks(id) {
  const playlistId = id.startsWith("sc-set:") ? id.substring(7) : id;
  const playlist = await scJson(`${SOUNDCLOUD}/playlists/${encodeURIComponent(playlistId)}`);
  const tracks = playlist && playlist.tracks ? playlist.tracks : [];
  const mapped = await Promise.all(
    tracks.map(async track => {
      if (!track || track.streamable === false) return null;
      const result = mapTrack(track);
      if (missingMetadata(result) && /^sc:\d+$/.test(result.id)) {
        try {
          const detail = await scJson(`${SOUNDCLOUD}/tracks/${encodeURIComponent(result.id.substring(3))}`);
          const full = mapTrack(detail);
          if (!result.title) result.title = full.title;
          if (!result.artist) result.artist = full.artist;
          if (!result.artwork) result.artwork = full.artwork;
          if (result.duration <= 0) result.duration = full.duration;
        } catch {
          return result;
        }
      }
      return result;
    })
  );
  return mapped.filter(Boolean);
}

function artistNamesMatch(candidate, requested) {
  const clean = value => String(value || "").trim().replace(/\.+$/, "").trim();
  return clean(candidate).toLowerCase() === clean(requested).toLowerCase();
}

function artistUserMatches(user, name) {
  if (!user) return false;
  return artistNamesMatch(user.username, name) || artistNamesMatch(user.permalink, name);
}

async function artist(id) {
  const uid = id.substring(3);
  let profile = null;
  try {
    profile = await scJson(`${SOUNDCLOUD}/users/${encodeURIComponent(uid)}`);
  } catch {
    profile = null;
  }

  const tracks = [];
  try {
    const data = await scJson(`${SOUNDCLOUD}/users/${encodeURIComponent(uid)}/tracks?limit=200`);
    const collection = data && data.collection ? data.collection : [];
    for (const item of collection) {
      if (!item) continue;
      if (!profile && item.user) profile = item.user;
      if (item.streamable === false) continue;
      tracks.push(mapTrack(item));
    }
  } catch {
    tracks.length = 0;
  }

  if (!profile) {
    try {
      const data = await scJson(`${SOUNDCLOUD}/search/users?q=${encodeURIComponent(uid)}&limit=5`);
      const collection = data && data.collection ? data.collection : [];
      profile = collection.find(item => item && String(item.id) === uid) || null;
    } catch {
      profile = null;
    }
  }

  if (!tracks.length && profile && profile.username) {
    try {
      const data = await scJson(`${SOUNDCLOUD}/search/tracks?q=${encodeURIComponent(profile.username)}&limit=50`);
      const collection = data && data.collection ? data.collection : [];
      for (const item of collection) {
        if (!item || !item.user) continue;
        if (String(item.user.id) !== uid) continue;
        if (item.streamable === false) continue;
        tracks.push(mapTrack(item));
      }
    } catch {
      tracks.length = 0;
    }
  }

  return {
    artist: {
      id,
      name: profile && profile.username ? profile.username : "",
      avatar: profile && profile.avatar_url ? profile.avatar_url : "",
      followers: profile && profile.followers_count ? profile.followers_count : 0,
      trackCount: profile && profile.track_count ? profile.track_count : tracks.length
    },
    tracks
  };
}

async function artistByName(name) {
  const candidates = [];
  const seen = new Set();
  const add = user => {
    if (!user || !user.id) return;
    const key = String(user.id);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(user);
  };

  const users = await scJson(`${SOUNDCLOUD}/search/users?q=${encodeURIComponent(name)}&limit=25`);
  for (const item of (users && users.collection) || []) {
    if (artistUserMatches(item, name)) add(item);
  }

  let fallback = null;
  for (const candidate of candidates) {
    const result = await artist("sc:" + candidate.id);
    if (!fallback) fallback = result;
    if (result.tracks.length) return result;
  }

  const tracks = await scJson(`${SOUNDCLOUD}/search/tracks?q=${encodeURIComponent(name)}&limit=50`);
  for (const item of (tracks && tracks.collection) || []) {
    if (item && item.user && artistUserMatches(item.user, name)) add(item.user);
  }

  for (const candidate of candidates.slice(0)) {
    const result = await artist("sc:" + candidate.id);
    if (!fallback) fallback = result;
    if (result.tracks.length) return result;
  }

  if (fallback) return fallback;
  throw new Error("No matching SoundCloud artist profile was found.");
}

function normalizeLyrics(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function stripTimestamps(value) {
  return String(value || "").replace(/\[\d+:\d{2}(?:\.\d{1,3})?\]/g, " ").trim();
}

function usableLyrics(value) {
  const normalized = normalizeLyrics(value);
  return normalized.length > 0 && normalized !== "probe";
}

function hasLyrics(track) {
  if (!track) return false;
  const synced = stripTimestamps(track.syncedLyrics || "");
  return usableLyrics(synced) || usableLyrics(track.plainLyrics || "");
}

function findLyricsMatch(results, title, artistName, duration) {
  const wantedTitle = normalizeLyrics(title);
  const wantedArtist = normalizeLyrics(artistName);
  let best = null;
  let bestScore = -Infinity;

  for (const track of results || []) {
    if (!hasLyrics(track)) continue;
    const candidateTitle = normalizeLyrics(track.trackName || "");
    const candidateArtistName = track.artistName || "";
    if (candidateTitle !== wantedTitle) continue;
    let artistMatch = normalizeLyrics(candidateArtistName) === wantedArtist;
    for (const requested of wantedArtist.split(",")) {
      const normalized = normalizeLyrics(requested);
      if (!normalized) continue;
      for (const returned of candidateArtistName.split(",")) {
        if (normalizeLyrics(returned) === normalized) artistMatch = true;
      }
    }
    if (!artistMatch) continue;
    let score = 160;
    if (duration > 0 && track.duration != null) {
      score -= Math.min(90, Math.abs(Number(track.duration) - duration));
    }
    if (track.syncedLyrics) score += 10;
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }
  return best;
}

async function lyrics(title, artistName, duration) {
  const root = LRCLIB;
  let match = null;
  try {
    let exact = `${root}/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artistName)}`;
    if (duration > 0) exact += "&duration=" + duration;
    match = await httpJson(exact);
  } catch (error) {
    match = null;
  }

  if (!hasLyrics(match)) {
    const results = await httpJson(`${root}/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artistName)}`);
    match = findLyricsMatch(results, title, artistName, duration);
  }

  return {
    found: hasLyrics(match),
    trackName: match && match.trackName ? match.trackName : title,
    artistName: match && match.artistName ? match.artistName : artistName,
    syncedLyrics: match && match.syncedLyrics ? match.syncedLyrics : "",
    plainLyrics: match && match.plainLyrics ? match.plainLyrics : ""
  };
}

async function spotifyEntity(type, id) {
  const html = await httpText(`https://open.spotify.com/embed/${type}/${id}`);
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Spotify did not return public embed data.");
  const root = JSON.parse(match[1]);
  const entity = root && root.props && root.props.pageProps && root.props.pageProps.state
    ? root.props.pageProps.state.data && root.props.pageProps.state.data.entity
    : null;
  if (!entity) throw new Error("Spotify playlist or track is unavailable.");
  return entity;
}

function spotifyArtwork(entity) {
  let sources = entity.coverArt && entity.coverArt.sources ? entity.coverArt.sources : null;
  if (!sources && entity.visualIdentity && entity.visualIdentity.image) sources = entity.visualIdentity.image;
  if (!sources) return "";
  let artwork = "";
  for (const source of sources) {
    if (source && source.url) artwork = source.url;
  }
  return artwork;
}

function mapSpotifyTrack(data, artwork) {
  let id = data.id || "";
  if (!id && data.uri) {
    const match = String(data.uri).match(/^spotify:track:([A-Za-z0-9]{22})$/);
    if (match) id = match[1];
  }
  if (!id) return null;

  const artistNames = [];
  const artistIds = [];
  for (const item of data.artists || []) {
    if (!item || !item.name) continue;
    artistNames.push(item.name);
    let artistId = item.id || "";
    if (!artistId && item.uri) {
      const match = String(item.uri).match(/^spotify:artist:([A-Za-z0-9]{22})$/);
      if (match) artistId = match[1];
    }
    artistIds.push(artistId);
  }
  if (!artistNames.length && data.subtitle) artistNames.push(data.subtitle);

  const preview = data.audioPreview && data.audioPreview.url ? data.audioPreview.url : "";
  return {
    id: "spotify:" + id,
    title: data.title || data.name || "",
    artist: artistNames.join(", "),
    artistNames,
    artistIds,
    artwork,
    duration: data.duration ? Math.round(data.duration / 1000) : 0,
    preview,
    stream: "",
    source: "spotify"
  };
}

async function spotifyTrack(id) {
  const entity = await spotifyEntity("track", id);
  const track = mapSpotifyTrack(entity, spotifyArtwork(entity));
  if (!track) throw new Error("Spotify track metadata is missing.");
  return track;
}

async function spotifyPlaylist(id) {
  const entity = await spotifyEntity("playlist", id);
  const artwork = spotifyArtwork(entity);
  const tracks = [];
  for (const item of entity.trackList || []) {
    if (!item) continue;
    const track = mapSpotifyTrack(item, artwork);
    if (track) tracks.push(track);
  }
  return {
    id: "spotify:" + id,
    title: entity.title || "",
    artist: entity.subtitle || "",
    artwork,
    source: "spotify",
    tracks
  };
}

async function resolveTranscoding(url) {
  if (!url) return null;
  const data = await scJson(url);
  return data && data.url ? data.url : null;
}

async function progressiveStreamUrl(id) {
  const trackId = id.startsWith("sc:") ? id.substring(3) : id;
  const track = await scJson(`${SOUNDCLOUD}/tracks/${encodeURIComponent(trackId)}`);
  const transcodings = track && track.media && track.media.transcodings ? track.media.transcodings : [];
  for (const transcoding of transcodings) {
    if (!transcoding || !transcoding.format) continue;
    if (String(transcoding.format.protocol || "").toLowerCase() !== "progressive") continue;
    const url = await resolveTranscoding(transcoding.url);
    if (url) return url;
  }
  return null;
}

async function streamRange(id, range) {
  const url = await progressiveStreamUrl(id);
  if (!url) return null;
  const headers = { "User-Agent": USER_AGENT, Accept: "*/*" };
  if (range) headers.Range = range;
  const response = await fetch(url, { headers, redirect: "follow" });
  if (!response.ok && response.status !== 206) throw new Error("Stream request failed with " + response.status);
  return response;
}

async function warm(id) {
  try {
    await progressiveStreamUrl(id);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}

async function oembed(target) {
  const data = await httpJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(target)}`);
  return { title: data.title || "", artwork: data.thumbnail_url || "" };
}

async function youtubeSearch(term, apiKey) {
  if (!apiKey) throw new Error("YouTube Data API key is not configured.");
  const url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoSyndicated=true&safeSearch=moderate&maxResults=10&q=" +
    encodeURIComponent(term);
  const data = await httpJson(url, { "X-Goog-Api-Key": apiKey });
  const items = data && data.items ? data.items : [];
  return items.map(item => ({
    id: item.id && item.id.videoId ? item.id.videoId : "",
    title: item.snippet ? item.snippet.title : "",
    author: item.snippet ? item.snippet.channelTitle : "",
    thumbnail: item.snippet && item.snippet.thumbnails && item.snippet.thumbnails.default
      ? item.snippet.thumbnails.default.url
      : "",
    url: item.id && item.id.videoId ? "https://www.youtube.com/watch?v=" + item.id.videoId : ""
  }));
}

module.exports = {
  search,
  searchPlaylists,
  playlistTracks,
  artist,
  artistByName,
  lyrics,
  spotifyTrack,
  spotifyPlaylist,
  streamRange,
  warm,
  oembed,
  youtubeSearch
};

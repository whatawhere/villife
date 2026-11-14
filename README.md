<p align="center">
  <img src="vilife.ico" alt="Vilife app icon" width="88">
</p>

<h1 align="center">Vilife</h1>

<p align="center">
  <strong>Find your sound. Make it yours.</strong><br>
  A Windows music player for discovering tracks, building a library, and staying in control of what plays next.
</p>

<p align="center">
  <a href="https://villife.hs.vc/"><img src="https://img.shields.io/badge/Visit%20Vilife-website-24252a?style=for-the-badge" alt="Visit the Vilife website"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows-1687d9?style=flat-square" alt="Windows">
  <img src="https://img.shields.io/badge/Interface-English%20%2F%20Russian-6956a5?style=flat-square" alt="English and Russian interface">
  <img src="https://img.shields.io/badge/Host-C%23%20%2B%20WebView2-326ce5?style=flat-square" alt="C sharp and WebView2">
  <img src="https://img.shields.io/badge/Project-In%20development-e39a31?style=flat-square" alt="In development">
</p>

<p align="center">
  <a href="#discover">Discover</a> &nbsp;·&nbsp;
  <a href="#make-it-yours">Make it yours</a> &nbsp;·&nbsp;
  <a href="#windows-integration">Windows integration</a> &nbsp;·&nbsp;
  <a href="#install">Install</a> &nbsp;·&nbsp;
  <a href="#build-from-source">Build</a> &nbsp;·&nbsp;
  <a href="#faq">FAQ</a>
</p>

---

## What is Vilife?

Vilife brings music discovery and your personal collection together in a focused desktop player. Search for tracks, albums, and playlists, save the ones you want to keep, and move between your queue, listening history, and recommendations.

The app is built as a lightweight Windows host with a web-based interface. Your library and preferences are stored locally in the WebView2 profile.

## Discover

- Search SoundCloud for tracks, albums, and playlists.
- Import public Spotify track and playlist metadata, then look for a matching playable track.
- Explore artist pages and find lyrics through LRCLIB.
- Keep listening with a queue, playback history, shuffle, and repeat.
- Add tracks from playlists to Favorites without leaving the playlist.

> **Spotify playback:** Spotify provides public track metadata, not a full playable stream. Vilife resolves imported tracks against available audio sources, so a match may not always be available.

## Make it yours

- Keep Favorites separate from your library.
- Import and export your library as JSON.
- Choose a light or dark theme and adjust interface preferences.
- Keep your volume and playback settings between sessions.
- Use keyboard shortcuts, a sleep timer, and optional crossfade.
- Browse in English or Russian.

Optional YouTube music-video backgrounds are also available. Video search needs a YouTube Data API key; the rest of the player does not.

## Windows integration

Vilife is designed to feel at home on Windows:

- **Media Session** exposes track information and playback controls to Windows.
- **System tray** provides Previous, Play/Pause, Next, and Quit controls.
- **Discord Rich Presence** can show the current track in the desktop Discord client.
- **WebView2** hosts the interface inside the native app window.

## Install

Visit the [Vilife website](https://villife.hs.vc/) for project information and available downloads.

When using a packaged build, extract the complete folder and launch `Vilife.exe`. Keep the `src` and `webview2` folders and the WebView2 support files alongside it. Microsoft Edge WebView2 Runtime is required.

## Build from source

### Requirements

- Windows
- MSBuild from Visual Studio or Visual Studio Build Tools
- .NET Framework 4.6.2 Developer Pack
- Microsoft Edge WebView2 Runtime
- WebView2 assemblies in the root `webview2` folder

Build from the project directory:

```powershell
msbuild .\src\Vilife.csproj /t:Build /p:Configuration=Release
```

The project writes `Vilife.exe` to the root folder. The app expects the `src` and `webview2` folders and `vilife.ico` to remain available beside the executable.

### Project layout

```text
.
├── src/
│   ├── Vilife.csproj       Windows desktop project
│   ├── villife.cs          App window, local server, and service endpoints
│   ├── Discord.cs          Discord Rich Presence
│   ├── index.html          Interface markup
│   ├── css/app.css         Interface styles
│   └── js/app.js           Player and interface behavior
├── webview2/               WebView2 assemblies
├── vilife.ico              App icon
└── README.md
```

## Privacy and services

Your library, Favorites, history, and settings are kept in the local WebView2 profile. Vilife contacts the relevant providers when you use their features: SoundCloud for music discovery and streams, Spotify for public metadata, LRCLIB for lyrics, and optionally YouTube for video search. Discord Rich Presence communicates with the local desktop Discord client.

## FAQ

<details>
  <summary>Do I need a Spotify account?</summary>
  <p>Vilife uses public Spotify metadata for importing tracks and playlists. It does not provide full playback from Spotify itself.</p>
</details>

<details>
  <summary>Why don't YouTube clips appear?</summary>
  <p>Clip search is optional and requires a YouTube Data API key. Music search and playback work independently of this feature.</p>
</details>

<details>
  <summary>Where is my library stored?</summary>
  <p>In the local WebView2 profile used by Vilife. Use the app's library export option to make a portable JSON copy.</p>
</details>

<details>
  <summary>Can I build Vilife without Visual Studio?</summary>
  <p>Yes, if MSBuild and the required .NET Framework targeting pack are installed. Run the build command above from PowerShell.</p>
</details>

---

<p align="center">
  <strong>Vilife — find your sound.</strong><br>
  <a href="https://villife.hs.vc/">villife.hs.vc</a>
</p>

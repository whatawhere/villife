<p align="center">
  <img src="villife.ico" alt="Villife" width="88">
</p>

<h1 align="center">Villife</h1>

<p align="center">
  A music player for Windows, macOS and Linux. SoundCloud search, a local library, queue and playback history, English and Russian interface.
</p>

<p align="center">
  <a href="https://villife.hs.vc/"><img src="https://img.shields.io/badge/Visit%20Villife-website-24252a?style=for-the-badge" alt="Website"></a>
  <a href="https://boosty.to/whata/donate"><img src="https://img.shields.io/badge/Boosty-Donate-F15A2C?style=for-the-badge&amp;logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB2ZXJzaW9uPSIxLjEiIGlkPSLQoNCO0KDCu9Cg0ZXQoOKEll8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB4PSIwcHgiIHk9IjBweCIKCSB2aWV3Qm94PSIwIDAgMjM1LjYgMjkyLjIiIHN0eWxlPSJlbmFibGUtYmFja2dyb3VuZDpuZXcgMCAwIDIzNS42IDI5Mi4yOyIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI%2BCjxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI%2BCgkuc3Qwe2ZpbGw6dXJsKCNTVkdJRF8xXyk7fQo8L3N0eWxlPgo8ZyBpZD0iYl8xXyI%2BCgk8bGluZWFyR3JhZGllbnQgaWQ9IlNWR0lEXzFfIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgeDE9IjE0NS4wNzc3IiB5MT0iNzYuMTQ4IiB4Mj0iODAuNTg2OCIgeTI9IjI5Ni4wNzg1Ij4KCQk8c3RvcCAgb2Zmc2V0PSIwIiBzdHlsZT0ic3RvcC1jb2xvcjojRUY3ODI5Ii8%2BCgkJPHN0b3AgIG9mZnNldD0iNS4xODk1MzhlLTAyIiBzdHlsZT0ic3RvcC1jb2xvcjojRjA3NTI5Ii8%2BCgkJPHN0b3AgIG9mZnNldD0iMC4zNTUxIiBzdHlsZT0ic3RvcC1jb2xvcjojRjA2NzJCIi8%2BCgkJPHN0b3AgIG9mZnNldD0iMC42NjczIiBzdHlsZT0ic3RvcC1jb2xvcjojRjE1RTJDIi8%2BCgkJPHN0b3AgIG9mZnNldD0iMSIgc3R5bGU9InN0b3AtY29sb3I6I0YxNUEyQyIvPgoJPC9saW5lYXJHcmFkaWVudD4KCTxwYXRoIGNsYXNzPSJzdDAiIGQ9Ik00NC4zLDE2NC41TDc2LjksNTEuNkgxMjdsLTEwLjEsMzVjLTAuMSwwLjItMC4yLDAuNC0wLjMsMC42TDkwLDE3OS42aDI0LjhjLTEwLjQsMjUuOS0xOC41LDQ2LjItMjQuMyw2MC45CgkJYy00NS44LTAuNS01OC42LTMzLjMtNDcuNC03Mi4xIE05MC43LDI0MC42bDYwLjQtODYuOWgtMjUuNmwyMi4zLTU1LjdjMzguMiw0LDU2LjIsMzQuMSw0NS42LDcwLjUKCQljLTExLjMsMzkuMS01Ny4xLDcyLjEtMTAxLjcsNzIuMUM5MS4zLDI0MC42LDkxLDI0MC42LDkwLjcsMjQwLjZ6Ii8%2BCjwvZz4KPC9zdmc%2BCg%3D%3D" alt="Donate on Boosty"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-1687d9?style=flat-square" alt="Windows, macOS, Linux">
  <img src="https://img.shields.io/badge/Interface-EN%20%7C%20RU-6956a5?style=flat-square" alt="EN and RU">
  <img src="https://img.shields.io/badge/Status-In%20development-e39a31?style=flat-square" alt="In development">
</p>

---

## What it does

Search SoundCloud for tracks, albums and playlists, save them to your library or Favorites, queue them up. Shuffle, repeat, sleep timer and crossfade are there as well.

Spotify is used only to import metadata for tracks and playlists — there is no Spotify stream. Villife looks for a matching track on other sources, and sometimes there is none.

Lyrics come from LRCLIB. YouTube video backgrounds are optional and need your own YouTube Data API key, everything else works without it.

On the Windows side: media keys through Media Session, tray controls (previous, play/pause, next, quit), Discord Rich Presence when the Discord desktop client is running.

## Install

**Windows** — `VillifeSetup.exe` from the [releases page](https://github.com/whatawhere/villife/releases/latest), or the zip: extract the whole folder, `src` and `villife.ico` have to stay next to `Villife.exe`. The first run downloads the browser engine, so internet is needed once, after that the library and settings live locally in the WebView2 profile.

**macOS** — `Villife-macOS-arm64.dmg` or `Villife-macOS-x64.dmg`, zip archives are there too.

**Linux** — `Villife-linux-x64.AppImage` or `Villife-linux-amd64.deb`.

macOS and Linux builds run the same interface through an Electron shell.

## Build

You need Windows, MSBuild (Visual Studio or the Build Tools), the .NET Framework 4.6.2 Developer Pack, and the WebView2 assemblies in the `webview2` folder at the project root — that folder is not in git.

```powershell
msbuild .\src\Villife.csproj /t:Build /p:Configuration=Release
```

You get `Villife.exe` in the project root.

## Layout

```text
.
├── src/
│   ├── Villife.csproj       Windows project
│   ├── villife.cs           window, local server, provider calls
│   ├── discord.cs           Discord Rich Presence
│   ├── index.html           interface markup
│   ├── css/app.css          styles
│   └── js/app.js            player logic
├── desktop/                 Electron shell for macOS and Linux builds
├── .github/workflows/       release pipeline
├── installer.iss            Inno Setup script
├── villife.ico              icon
└── README.md
```

## About the data

Library, favorites, history and settings stay in the local WebView2 profile. The only network calls are the ones you'd expect: SoundCloud for search and streams, Spotify for public metadata, LRCLIB for lyrics, YouTube for video search if you turned it on, and Discord presence to the local client.

## Questions

**Do I need a Spotify account?** No. Public metadata is used for imports, playback has nothing to do with Spotify.

**Why are there no YouTube clips?** They are optional and need an API key. Search and playback work without them.

**Where is my library?** In the local WebView2 profile. There is a JSON export if you want a portable copy.

---

<p align="center">
  <a href="https://villife.hs.vc/">villife.hs.vc</a>
</p>

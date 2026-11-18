using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

namespace Villife
{
    static class Program
    {
        static string wwwPath;
        static string clientId = "39AVoiZVrdvJEMFLH8T0c5WGshQaAPRJ";
        static readonly object idLock = new object();
        static readonly Dictionary<string, CacheEntry> cache = new Dictionary<string, CacheEntry>();
        static readonly object cacheLock = new object();
        static readonly Dictionary<string, StreamEntry> streamUrls = new Dictionary<string, StreamEntry>();
        static readonly object streamUrlLock = new object();
        const string ScUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool SetDllDirectory(string path);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        class StreamEntry
        {
            public string Url;
            public DateTime At;
        }

        class CacheEntry
        {
            public byte[] Data;
            public string Mime;
            public DateTime At;
        }

        static string ResolveWebRoot()
        {
            var candidates = new[]
            {
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "src"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "source"),
                Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "source")
            };

            foreach (var candidate in candidates)
            {
                try
                {
                    if (Directory.Exists(candidate) && File.Exists(Path.Combine(candidate, "index.html")))
                        return candidate;
                }
                catch
                {
                }
            }

            return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "src");
        }

        [STAThread]
        static void Main()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            wwwPath = ResolveWebRoot();

            string browserMessage;
            if (!EnsureBrowser(out browserMessage))
            {
                MessageBox.Show(browserMessage, "Villife", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            int port = StartServer();
            if (port == 0)
            {
                return;
            }
            Application.Run(new MainForm(port));
        }

        static SecurityProtocolType SecurityPointManagerType()
        {
            return SecurityProtocolType.Tls12;
        }

        static string BrowserCacheDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Villife", "browser");
        }

        public static string BrowserProfileDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Villife", "profile");
        }

        static bool EnsureBrowser(out string message)
        {
            message = "";

            var bundled = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "webview2");
            if (File.Exists(Path.Combine(bundled, "Microsoft.Web.WebView2.Core.dll")))
            {
                SetDllDirectory(bundled);
                return BrowserRuntimePresent();
            }

            if (!EnsureBrowserRuntime(out message))
                return false;

            var cache = BrowserCacheDir();
            var core = Path.Combine(cache, "Microsoft.Web.WebView2.Core.dll");
            var forms = Path.Combine(cache, "Microsoft.Web.WebView2.WinForms.dll");
            var loader = Path.Combine(cache, "WebView2Loader.dll");

            if (!File.Exists(core) || !File.Exists(forms) || !File.Exists(loader))
            {
                try
                {
                    FetchBrowserComponents(cache);
                }
                catch (Exception error)
                {
                    message = "Не удалось скачать браузерный компонент.\n\n" + error.Message +
                              "\n\nПроверь подключение к интернету и запусти Villife ещё раз.";
                    return false;
                }
            }

            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs args)
            {
                try
                {
                    var simple = new AssemblyName(args.Name).Name;
                    var candidate = Path.Combine(cache, simple + ".dll");
                    if (File.Exists(candidate))
                        return Assembly.LoadFrom(candidate);
                }
                catch
                {
                }
                return null;
            };

            SetDllDirectory(cache);
            return true;
        }

        static bool BrowserRuntimePresent()
        {
            var keys = new[]
            {
                @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
                @"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
            };
            foreach (var key in keys)
            {
                try
                {
                    using (var handle = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(key))
                    {
                        if (handle != null && handle.GetValue("pv") != null)
                            return true;
                    }
                }
                catch
                {
                }
            }
            return false;
        }

        static bool EnsureBrowserRuntime(out string message)
        {
            message = "";
            if (BrowserRuntimePresent())
                return true;

            var bootstrapper = Path.Combine(Path.GetTempPath(), "villife-runtime-" + Guid.NewGuid().ToString("N") + ".exe");
            try
            {
                using (var client = new WebClient())
                {
                    client.Headers.Add("User-Agent", ScUa);
                    client.DownloadFile("https://go.microsoft.com/fwlink/p/?LinkId=2124703", bootstrapper);
                }

                var start = new ProcessStartInfo(bootstrapper, "/silent /install") { UseShellExecute = true };
                var installer = Process.Start(start);
                if (installer != null)
                    installer.WaitForExit(300000);
            }
            catch (Exception error)
            {
                message = error.Message;
            }
            finally
            {
                try { File.Delete(bootstrapper); } catch { }
            }

            if (BrowserRuntimePresent())
                return true;

            if (message.Length == 0)
                message = "Microsoft Edge WebView2 Runtime не установлен.";
            message += "\n\nУстанови его и запусти Villife ещё раз:\nhttps://developer.microsoft.com/microsoft-edge/webview2/";
            return false;
        }

        static void FetchBrowserComponents(string cache)
        {
            const string version = "1.0.4314.35";
            var package = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/" + version +
                          "/microsoft.web.webview2." + version + ".nupkg";

            var temp = Path.Combine(Path.GetTempPath(), "villife-browser-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(temp);
            try
            {
                var archive = Path.Combine(temp, "browser.nupkg");
                using (var client = new WebClient())
                {
                    client.Headers.Add("User-Agent", ScUa);
                    client.DownloadFile(package, archive);
                }

                using (var zip = ZipFile.OpenRead(archive))
                {
                    ExtractEntry(zip, "lib/net462/Microsoft.Web.WebView2.Core.dll", cache);
                    ExtractEntry(zip, "lib/net462/Microsoft.Web.WebView2.WinForms.dll", cache);
                    ExtractEntry(zip, "build/native/x64/WebView2Loader.dll", cache);
                }
            }
            finally
            {
                try { Directory.Delete(temp, true); } catch { }
            }
        }

        static void ExtractEntry(ZipArchive archive, string entryName, string targetDir)
        {
            var entry = archive.GetEntry(entryName);
            if (entry == null)
                throw new FileNotFoundException("Составная часть пакета не найдена: " + entryName);
            Directory.CreateDirectory(targetDir);
            entry.ExtractToFile(Path.Combine(targetDir, Path.GetFileName(entryName)), true);
        }

        static int StartServer()
        {
            for (int p = 8080; p < 8090; p++)
            {
                try
                {
                    var listener = new TcpListener(IPAddress.Loopback, p);
                    listener.Start();
                    var thread = new Thread(() => AcceptLoop(listener));
                    thread.IsBackground = true;
                    thread.Start();
                    return p;
                }
                catch (SocketException)
                {
                }
            }
            return 0;
        }

        static void AcceptLoop(TcpListener listener)
        {
            while (true)
            {
                try
                {
                    var client = listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(delegate { Handle(client); });
                }
                catch
                {
                    return;
                }
            }
        }

        static void Handle(TcpClient client)
        {
            try
            {
                using (client)
                {
                    var stream = client.GetStream();
                    var head = ReadRequest(stream);
                    if (head == null) return;

                    var line = head.Split('\n')[0].Trim();
                    var parts = line.Split(' ');
                    if (parts.Length < 2)
                    {
                        WriteResponse(stream, 400, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("bad request"), "");
                        return;
                    }
                    if (parts[0] != "GET")
                    {
                        WriteResponse(stream, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("method not allowed"), "Allow: GET\r\n");
                        return;
                    }

                    var rawUrl = parts[1];
                    var q = rawUrl.IndexOf('?');
                    var path = q >= 0 ? rawUrl.Substring(0, q) : rawUrl;
                    var query = q >= 0 ? rawUrl.Substring(q + 1) : "";
                    path = Uri.UnescapeDataString(path);
                    int status = 200;
                    string mime = "text/plain; charset=utf-8";
                    string extra = "";
                    byte[] body;

                    if (path == "/" || path == "/index.html")
                    {
                        var indexPath = Path.Combine(wwwPath, "index.html");
                        if (!File.Exists(indexPath))
                        {
                            status = 404;
                            body = Encoding.UTF8.GetBytes("not found");
                            mime = "text/plain; charset=utf-8";
                        }
                        else
                        {
                            body = File.ReadAllBytes(indexPath);
                            mime = "text/html; charset=utf-8";
                        }
                    }
                    else if (path == "/css/app.css")
                    {
                        var cssPath = Path.Combine(wwwPath, "css", "app.css");
                        if (!File.Exists(cssPath))
                        {
                            status = 404;
                            body = Encoding.UTF8.GetBytes("not found");
                            mime = "text/plain; charset=utf-8";
                        }
                        else
                        {
                            body = File.ReadAllBytes(cssPath);
                            mime = "text/css; charset=utf-8";
                        }
                    }
                    else if (path == "/js/app.js")
                    {
                        var jsPath = Path.Combine(wwwPath, "js", "app.js");
                        if (!File.Exists(jsPath))
                        {
                            status = 404;
                            body = Encoding.UTF8.GetBytes("not found");
                            mime = "text/plain; charset=utf-8";
                        }
                        else
                        {
                            body = File.ReadAllBytes(jsPath);
                            mime = "application/javascript; charset=utf-8";
                        }
                    }
                    else if (path == "/villife.ico")
                    {
                        var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "villife.ico");
                        if (!File.Exists(iconPath))
                        {
                            status = 404;
                            body = Encoding.UTF8.GetBytes("not found");
                            mime = "text/plain; charset=utf-8";
                        }
                        else
                        {
                            body = File.ReadAllBytes(iconPath);
                            mime = "image/x-icon";
                        }
                    }
                    else if (path == "/api/search")
                    {
                        var term = GetParam(query, "q");
                        if (term.Length == 0)
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"no query\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                body = Encoding.UTF8.GetBytes(Search(term));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/search/playlists")
                    {
                        var term = GetParam(query, "q");
                        if (term.Length == 0)
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"no query\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                body = Encoding.UTF8.GetBytes(SearchPlaylists(term));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/playlist")
                    {
                        var id = GetParam(query, "id");
                        if (!Regex.IsMatch(id, @"^(?:sc-set:)?[0-9]+$"))
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"invalid playlist id\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                body = Encoding.UTF8.GetBytes(GetPlaylistTracks(id));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/spotify/track" || path == "/api/spotify/playlist")
                    {
                        var id = GetParam(query, "id");
                        if (!Regex.IsMatch(id, @"^[A-Za-z0-9]{22}$"))
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"invalid Spotify id\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                body = Encoding.UTF8.GetBytes(path == "/api/spotify/track"
                                    ? GetSpotifyTrack(id)
                                    : GetSpotifyPlaylist(id));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/artist")
                    {
                        var id = GetParam(query, "id");
                        var name = GetParam(query, "name");
                        if ((id.Length > 0 && !Regex.IsMatch(id, @"^sc:[0-9]+$")) || (id.Length == 0 && name.Length == 0))
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"invalid artist id\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                body = Encoding.UTF8.GetBytes(id.Length > 0 ? GetArtist(id) : GetArtistByName(name));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/lyrics")
                    {
                        var title = GetParam(query, "track_name");
                        var artist = GetParam(query, "artist_name");
                        int duration;
                        if (title.Length == 0 || artist.Length == 0)
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"track name and artist are required\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            var durationText = GetParam(query, "duration");
                            if (!int.TryParse(durationText, out duration) || duration < 0 || duration > 86400)
                                duration = 0;
                            try
                            {
                                body = Encoding.UTF8.GetBytes(GetLyrics(title, artist, duration));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/youtube/search")
                    {
                        var term = GetParam(query, "q");
                        if (term.Length == 0 || term.Length > 240)
                        {
                            status = 400;
                            body = JsonError("a track title and artist are required");
                            mime = "application/json; charset=utf-8";
                        }
                        else if (String.IsNullOrWhiteSpace(GetYouTubeApiKey()))
                        {
                            status = 503;
                            body = JsonError("YouTube Data API key is not configured.");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                body = Encoding.UTF8.GetBytes(SearchYouTubeVideos(term));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/oembed")
                    {
                        var target = GetParam(query, "url");
                        if (target.Length == 0)
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"no url\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else if (!IsSpotifyTrackUrl(target))
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"invalid Spotify track URL\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                body = Encoding.UTF8.GetBytes(OEmbed(target));
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/warm")
                    {
                        var id = GetParam(query, "id");
                        if (!Regex.IsMatch(id, @"^(?:sc:)?[0-9]+$"))
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"invalid track id\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            try
                            {
                                var ready = !string.IsNullOrEmpty(GetProgressiveStreamUrl(id));
                                if (!ready)
                                {
                                    string warmedMime;
                                    ready = FetchTrack(id, out warmedMime) != null;
                                }
                                body = Encoding.UTF8.GetBytes("{\"ready\":" + (ready ? "true" : "false") + "}");
                                mime = "application/json; charset=utf-8";
                            }
                            catch (Exception e)
                            {
                                status = 502;
                                body = JsonError(e.Message);
                                mime = "application/json; charset=utf-8";
                            }
                        }
                    }
                    else if (path == "/api/stream")
                    {
                        var id = GetParam(query, "id");
                        if (!Regex.IsMatch(id, @"^(?:sc:)?[0-9]+$"))
                        {
                            status = 400;
                            body = Encoding.UTF8.GetBytes("{\"error\":\"invalid track id\"}");
                            mime = "application/json; charset=utf-8";
                        }
                        else
                        {
                            string smime;
                            try
                            {
                                if (ProxyProgressiveTrack(stream, id, GetHeader(head, "Range"))) return;
                                body = FetchTrack(id, out smime);
                            }
                            catch (Exception e)
                            {
                                Trace.TraceError("Stream request failed: " + e);
                                status = 502;
                                body = Encoding.UTF8.GetBytes("{\"error\":\"stream request failed\"}");
                                smime = "audio/mpeg";
                            }
                            if (status == 502)
                            {
                                mime = "application/json; charset=utf-8";
                            }
                            else if (body == null)
                            {
                                status = 404;
                                body = Encoding.UTF8.GetBytes("{\"error\":\"not found\"}");
                                mime = "application/json; charset=utf-8";
                            }
                            else
                            {
                                mime = smime;
                                extra = "Accept-Ranges: bytes\r\n";
                                var slice = ApplyRange(GetHeader(head, "Range"), body, ref status, ref extra);
                                if (slice != null) body = slice;
                            }
                        }
                    }
                    else
                    {
                        status = 404;
                        body = Encoding.UTF8.GetBytes("not found");
                    }

                    WriteResponse(stream, status, mime, body, extra);
                }
            }
            catch (Exception e)
            {
                Trace.TraceError("Request handling failed: " + e);
            }
        }

        static void WriteResponse(NetworkStream stream, int status, string mime, byte[] body, string extra)
        {
            var head = "HTTP/1.1 " + status + " " + StatusText(status) + "\r\n" +
                       "Content-Type: " + mime + "\r\n" +
                       "Content-Length: " + body.Length + "\r\n" +
                       "Cache-Control: no-store\r\n" +
                       extra +
                       "Connection: close\r\n\r\n";
            var headBytes = Encoding.ASCII.GetBytes(head);
            stream.Write(headBytes, 0, headBytes.Length);
            stream.Write(body, 0, body.Length);
            stream.Flush();
        }

        static string StatusText(int status)
        {
            if (status == 200) return "OK";
            if (status == 206) return "Partial Content";
            if (status == 400) return "Bad Request";
            if (status == 404) return "Not Found";
            if (status == 405) return "Method Not Allowed";
            if (status == 502) return "Bad Gateway";
            if (status == 503) return "Service Unavailable";
            return "Error";
        }

        static bool IsSpotifyTrackUrl(string target)
        {
            Uri uri;
            if (!Uri.TryCreate(target, UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttps || !uri.Host.Equals("open.spotify.com", StringComparison.OrdinalIgnoreCase))
                return false;
            return Regex.IsMatch(uri.AbsolutePath, @"^/track/[A-Za-z0-9]{22}/?$");
        }

        static byte[] JsonError(string message)
        {
            var error = new Dictionary<string, object>();
            error["error"] = message;
            return Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(error));
        }

        static string GetHeader(string head, string name)
        {
            foreach (var raw in head.Split('\n'))
            {
                var l = raw.Trim();
                if (l.Length > name.Length + 1 &&
                    string.Compare(l.Substring(0, name.Length), name, StringComparison.OrdinalIgnoreCase) == 0 &&
                    l[name.Length] == ':')
                    return l.Substring(name.Length + 1).Trim();
            }
            return null;
        }

        static byte[] ApplyRange(string range, byte[] body, ref int status, ref string extra)
        {
            if (range == null) return null;
            var m = Regex.Match(range, @"^bytes=(\d*)-(\d*)$");
            if (!m.Success) return null;
            int start = 0;
            int end = body.Length - 1;
            if (m.Groups[1].Value.Length > 0) int.TryParse(m.Groups[1].Value, out start);
            if (m.Groups[2].Value.Length > 0) int.TryParse(m.Groups[2].Value, out end);
            if (start < 0 || start >= body.Length || start > end) return null;
            if (end >= body.Length) end = body.Length - 1;
            var slice = new byte[end - start + 1];
            Array.Copy(body, start, slice, 0, slice.Length);
            status = 206;
            extra += "Content-Range: bytes " + start + "-" + end + "/" + body.Length + "\r\n";
            return slice;
        }

        static string ReadRequest(NetworkStream stream)
        {
            var buf = new byte[8192];
            var data = new List<byte>();
            while (data.Count < 16384)
            {
                int n = stream.Read(buf, 0, buf.Length);
                if (n <= 0) return null;
                for (int i = 0; i < n; i++) data.Add(buf[i]);
                var text = Encoding.ASCII.GetString(data.ToArray());
                if (text.IndexOf("\r\n\r\n") >= 0) return text;
            }
            return null;
        }

        static string GetParam(string query, string key)
        {
            foreach (var pair in query.Split('&'))
            {
                var kv = pair.Split(new char[] { '=' }, 2);
                if (kv.Length == 2 && kv[0] == key)
                    return Uri.UnescapeDataString(kv[1].Replace('+', ' '));
            }
            return "";
        }

        static string HttpGet(string url)
        {
            using (var wc = new WebClient())
            {
                wc.Encoding = Encoding.UTF8;
                wc.Headers.Add("User-Agent", ScUa);
                wc.Headers.Add("Accept", "*/*");
                return wc.DownloadString(url);
            }
        }

        static string LrclibGet(string url)
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.UserAgent = "Villife/1.0";
            request.Accept = "application/json";
            request.Timeout = 12000;
            request.ReadWriteTimeout = 12000;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                return reader.ReadToEnd();
        }

        static string GetLyrics(string title, string artist, int duration)
        {
            var root = "https://lrclib.net/api/";
            var exactUrl = root + "get?track_name=" + Uri.EscapeDataString(title) +
                "&artist_name=" + Uri.EscapeDataString(artist);
            if (duration > 0) exactUrl += "&duration=" + duration;

            Dictionary<string, object> match = null;
            try
            {
                match = new JavaScriptSerializer().DeserializeObject(LrclibGet(exactUrl)) as Dictionary<string, object>;
            }
            catch (WebException error)
            {
                var response = error.Response as HttpWebResponse;
                if (response == null || response.StatusCode != HttpStatusCode.NotFound) throw;
                response.Close();
            }

            if (!HasLyrics(match))
            {
                var searchUrl = root + "search?track_name=" + Uri.EscapeDataString(title) +
                    "&artist_name=" + Uri.EscapeDataString(artist);
                var results = new JavaScriptSerializer().DeserializeObject(LrclibGet(searchUrl)) as object[];
                match = FindLyricsMatch(results, title, artist, duration);
            }

            var output = new Dictionary<string, object>();
            output["found"] = HasLyrics(match);
            output["trackName"] = match != null && match.ContainsKey("trackName") ? match["trackName"] : title;
            output["artistName"] = match != null && match.ContainsKey("artistName") ? match["artistName"] : artist;
            output["syncedLyrics"] = match != null && match.ContainsKey("syncedLyrics") ? match["syncedLyrics"] : "";
            output["plainLyrics"] = match != null && match.ContainsKey("plainLyrics") ? match["plainLyrics"] : "";
            return new JavaScriptSerializer().Serialize(output);
        }

        static bool HasLyrics(Dictionary<string, object> track)
        {
            if (track == null) return false;
            var synced = track.ContainsKey("syncedLyrics") ? Convert.ToString(track["syncedLyrics"]) : "";
            var plain = track.ContainsKey("plainLyrics") ? Convert.ToString(track["plainLyrics"]) : "";
            synced = Regex.Replace(synced ?? "", @"\[\d+:\d{2}(?:\.\d{1,3})?\]", " ").Trim();
            return HasUsableLyrics(synced) || HasUsableLyrics(plain);
        }

        static bool HasUsableLyrics(string lyrics)
        {
            var normalized = NormalizeLyricsText(lyrics);
            return normalized.Length > 0 && normalized != "probe";
        }

        static Dictionary<string, object> FindLyricsMatch(object[] results, string title, string artist, int duration)
        {
            if (results == null) return null;
            var wantedTitle = NormalizeLyricsText(title);
            var wantedArtist = NormalizeLyricsText(artist);
            Dictionary<string, object> best = null;
            var bestScore = int.MinValue;
            foreach (var item in results)
            {
                var track = item as Dictionary<string, object>;
                if (!HasLyrics(track)) continue;
                var candidateTitle = track.ContainsKey("trackName") ? NormalizeLyricsText(Convert.ToString(track["trackName"])) : "";
                var candidateArtistName = track.ContainsKey("artistName") ? Convert.ToString(track["artistName"]) : "";
                var candidateArtist = NormalizeLyricsText(candidateArtistName);
                if (candidateTitle != wantedTitle) continue;
                var artistMatch = candidateArtist == wantedArtist;
                var requestedArtists = artist.Split(',');
                var returnedArtists = candidateArtistName.Split(',');
                foreach (var requestedArtist in requestedArtists)
                {
                    var normalizedRequested = NormalizeLyricsText(requestedArtist);
                    if (normalizedRequested.Length == 0) continue;
                    foreach (var returnedArtist in returnedArtists)
                        if (NormalizeLyricsText(returnedArtist) == normalizedRequested) artistMatch = true;
                }
                if (!artistMatch) continue;
                var score = 160;
                if (duration > 0 && track.ContainsKey("duration") && track["duration"] != null)
                {
                    var difference = Math.Abs(Convert.ToDouble(track["duration"]) - duration);
                    score -= (int)Math.Min(90, difference);
                }
                if (track.ContainsKey("syncedLyrics") && !string.IsNullOrEmpty(Convert.ToString(track["syncedLyrics"])))
                    score += 10;
                if (score > bestScore)
                {
                    best = track;
                    bestScore = score;
                }
            }
            return best;
        }

        static string NormalizeLyricsText(string value)
        {
            return Regex.Replace((value ?? "").ToLowerInvariant(), @"[^\p{L}\p{N}]+", "");
        }

        static byte[] HttpBytes(string url)
        {
            using (var wc = new WebClient())
            {
                wc.Headers.Add("User-Agent", ScUa);
                wc.Headers.Add("Accept", "*/*");
                return wc.DownloadData(url);
            }
        }

        static string ScGet(string url)
        {
            var sep = url.IndexOf('?') >= 0 ? "&" : "?";
            for (int attempt = 0; attempt < 2; attempt++)
            {
                try
                {
                    return HttpGet(url + sep + "client_id=" + clientId);
                }
                catch (WebException we)
                {
                    var resp = we.Response as HttpWebResponse;
                    var code = resp != null ? (int)resp.StatusCode : 0;
                    if (attempt == 0 && (code == 401 || code == 403) && RefreshClientId()) continue;
                    throw;
                }
            }
            return null;
        }

        static bool RefreshClientId()
        {
            lock (idLock)
            {
                try
                {
                    var home = HttpGet("https://soundcloud.com/");
                    var scripts = Regex.Matches(home, "src=\"(https://a-v2\\.sndcdn\\.com/assets/[^\"]+\\.js)\"");
                    int n = 0;
                    foreach (Match sm in scripts)
                    {
                        if (n++ > 12) break;
                        string js;
                        try { js = HttpGet(sm.Groups[1].Value); }
                        catch { continue; }
                        var cm = Regex.Match(js, "client_id[\"']?\\s*[:=]\\s*[\"']([a-zA-Z0-9]{32})[\"']");
                        if (cm.Success)
                        {
                            clientId = cm.Groups[1].Value;
                            return true;
                        }
                    }
                }
                catch
                {
                }
                return false;
            }
        }

        static string Search(string term)
        {
            var json = ScGet("https://api-v2.soundcloud.com/search/tracks?q=" + Uri.EscapeDataString(term) + "&limit=24");
            var ser = new JavaScriptSerializer();
            var root = ser.DeserializeObject(json) as Dictionary<string, object>;
            var results = root != null && root.ContainsKey("collection") ? root["collection"] as object[] : null;
            var list = new List<Dictionary<string, object>>();

            if (results != null)
            {
                foreach (var item in results)
                {
                    var d = item as Dictionary<string, object>;
                    if (d == null) continue;
                    if (d.ContainsKey("streamable") && d["streamable"] is bool && !(bool)d["streamable"]) continue;
                    list.Add(MapTrack(d));
                }
            }

            return ser.Serialize(list);
        }

        static string SearchPlaylists(string term)
        {
            var json = ScGet("https://api-v2.soundcloud.com/search/playlists?q=" + Uri.EscapeDataString(term) + "&limit=12");
            var root = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            var results = root != null && root.ContainsKey("collection") ? root["collection"] as object[] : null;
            var list = new List<Dictionary<string, object>>();

            if (results != null)
            {
                foreach (var item in results)
                {
                    var playlist = item as Dictionary<string, object>;
                    if (playlist == null) continue;
                    var user = playlist.ContainsKey("user") ? playlist["user"] as Dictionary<string, object> : null;
                    var tracks = playlist.ContainsKey("tracks") ? playlist["tracks"] as object[] : null;
                    var artwork = playlist.ContainsKey("artwork_url") ? playlist["artwork_url"] as string : null;
                    if (string.IsNullOrEmpty(artwork) && tracks != null && tracks.Length > 0)
                    {
                        var firstTrack = tracks[0] as Dictionary<string, object>;
                        if (firstTrack != null && firstTrack.ContainsKey("artwork_url"))
                            artwork = firstTrack["artwork_url"] as string;
                    }
                    if (string.IsNullOrEmpty(artwork) && user != null && user.ContainsKey("avatar_url"))
                        artwork = user["avatar_url"] as string;
                    if (!string.IsNullOrEmpty(artwork))
                    {
                        artwork = artwork.Replace("-large.", "-t500x500.");
                        artwork = artwork.Replace("i1.sndcdn.com", "i2.sndcdn.com");
                    }

                    var setType = playlist.ContainsKey("set_type") ? playlist["set_type"] as string : null;
                    var isAlbum = (playlist.ContainsKey("is_album") && playlist["is_album"] is bool && (bool)playlist["is_album"]) ||
                                  string.Equals(setType, "album", StringComparison.OrdinalIgnoreCase);
                    var date = playlist.ContainsKey("release_date") ? playlist["release_date"] as string : null;
                    if (string.IsNullOrEmpty(date) && playlist.ContainsKey("created_at"))
                        date = playlist["created_at"] as string;

                    var entry = new Dictionary<string, object>();
                    entry["id"] = "sc-set:" + (playlist.ContainsKey("id") ? Convert.ToInt64(playlist["id"]) : 0);
                    entry["title"] = playlist.ContainsKey("title") && playlist["title"] != null ? playlist["title"] : "";
                    entry["artist"] = user != null && user.ContainsKey("username") ? user["username"] as string : "";
                    entry["artistId"] = user != null && user.ContainsKey("id") ? "sc:" + Convert.ToInt64(user["id"]) : "";
                    entry["artwork"] = artwork;
                    entry["trackCount"] = playlist.ContainsKey("track_count") ? Convert.ToInt64(playlist["track_count"]) : 0;
                    entry["year"] = !string.IsNullOrEmpty(date) && date.Length >= 4 ? date.Substring(0, 4) : "";
                    entry["type"] = isAlbum ? "album" : "playlist";
                    list.Add(entry);
                }
            }

            return new JavaScriptSerializer().Serialize(list);
        }

        static string GetPlaylistTracks(string id)
        {
            var playlistId = id.StartsWith("sc-set:", StringComparison.Ordinal) ? id.Substring(7) : id;
            var json = ScGet("https://api-v2.soundcloud.com/playlists/" + playlistId);
            var playlist = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            var tracks = playlist != null && playlist.ContainsKey("tracks") ? playlist["tracks"] as object[] : null;
            if (tracks == null)
                return new JavaScriptSerializer().Serialize(new List<Dictionary<string, object>>());

            var mappedTracks = new Dictionary<string, object>[tracks.Length];
            Parallel.For(0, tracks.Length, new ParallelOptions { MaxDegreeOfParallelism = 4 }, delegate(int index)
            {
                var track = tracks[index] as Dictionary<string, object>;
                if (track == null || (track.ContainsKey("streamable") && track["streamable"] is bool && !(bool)track["streamable"]))
                    return;

                var mappedTrack = MapTrack(track);
                if (HasMissingTrackMetadata(mappedTrack))
                {
                    try
                    {
                        var trackId = mappedTrack["id"] as string;
                        if (!string.IsNullOrEmpty(trackId) &&
                            Regex.IsMatch(trackId, @"^sc:[0-9]+$"))
                        {
                            var detailJson = ScGet("https://api-v2.soundcloud.com/tracks/" +
                                Uri.EscapeDataString(trackId.Substring(3)));
                            var detail = new JavaScriptSerializer().DeserializeObject(detailJson) as Dictionary<string, object>;
                            if (detail != null)
                                MergeMissingTrackMetadata(mappedTrack, MapTrack(detail));
                        }
                    }
                    catch (Exception e)
                    {
                        Trace.TraceError("Could not load missing SoundCloud playlist track metadata: " +
                            mappedTrack["id"] + ". " + e);
                    }
                }

                mappedTracks[index] = mappedTrack;
            });

            var list = new List<Dictionary<string, object>>(tracks.Length);
            foreach (var track in mappedTracks)
                if (track != null) list.Add(track);
            return new JavaScriptSerializer().Serialize(list);
        }

        static bool HasMissingTrackMetadata(Dictionary<string, object> track)
        {
            return string.IsNullOrEmpty(Convert.ToString(track["title"])) ||
                   string.IsNullOrEmpty(Convert.ToString(track["artist"])) ||
                   string.IsNullOrEmpty(Convert.ToString(track["artwork"])) ||
                   Convert.ToInt64(track["duration"]) <= 0;
        }

        static void MergeMissingTrackMetadata(Dictionary<string, object> track, Dictionary<string, object> details)
        {
            if (string.IsNullOrEmpty(Convert.ToString(track["title"])))
                track["title"] = details["title"];
            if (string.IsNullOrEmpty(Convert.ToString(track["artist"])))
                track["artist"] = details["artist"];
            if (string.IsNullOrEmpty(Convert.ToString(track["artwork"])))
                track["artwork"] = details["artwork"];
            if (Convert.ToInt64(track["duration"]) <= 0)
                track["duration"] = details["duration"];
        }

        static string GetArtistByName(string name)
        {
            var json = ScGet("https://api-v2.soundcloud.com/search/users?q=" + Uri.EscapeDataString(name) + "&limit=25");
            var root = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            var results = root != null && root.ContainsKey("collection") ? root["collection"] as object[] : null;
            var candidates = new List<Dictionary<string, object>>();
            AddArtistCandidates(candidates, results, name);
            string emptyProfile = null;
            foreach (var candidate in candidates)
            {
                var artistJson = GetArtist("sc:" + Convert.ToInt64(candidate["id"]));
                if (emptyProfile == null) emptyProfile = artistJson;
                if (ArtistHasTracks(artistJson)) return artistJson;
            }

            var tracksJson = ScGet("https://api-v2.soundcloud.com/search/tracks?q=" + Uri.EscapeDataString(name) + "&limit=50");
            var tracksRoot = new JavaScriptSerializer().DeserializeObject(tracksJson) as Dictionary<string, object>;
            var tracks = tracksRoot != null && tracksRoot.ContainsKey("collection") ? tracksRoot["collection"] as object[] : null;
            var trackCandidateStart = candidates.Count;
            if (tracks != null)
            {
                foreach (var item in tracks)
                {
                    var track = item as Dictionary<string, object>;
                    var user = track != null && track.ContainsKey("user") ? track["user"] as Dictionary<string, object> : null;
                    if (user != null && user.ContainsKey("id") && ArtistUserMatches(user, name))
                        AddArtistCandidate(candidates, user);
                }
            }

            for (int i = trackCandidateStart; i < candidates.Count; i++)
            {
                var candidate = candidates[i];
                var artistJson = GetArtist("sc:" + Convert.ToInt64(candidate["id"]));
                if (emptyProfile == null) emptyProfile = artistJson;
                if (ArtistHasTracks(artistJson)) return artistJson;
            }

            if (emptyProfile != null) return emptyProfile;
            throw new InvalidOperationException("No matching SoundCloud artist profile was found.");
        }

        static void AddArtistCandidates(List<Dictionary<string, object>> candidates, object[] users, string name)
        {
            if (users == null) return;
            foreach (var item in users)
            {
                var user = item as Dictionary<string, object>;
                if (user != null && user.ContainsKey("id") && ArtistUserMatches(user, name))
                    AddArtistCandidate(candidates, user);
            }
        }

        static void AddArtistCandidate(List<Dictionary<string, object>> candidates, Dictionary<string, object> user)
        {
            var id = Convert.ToString(user["id"]);
            foreach (var candidate in candidates)
                if (Convert.ToString(candidate["id"]) == id) return;
            candidates.Add(user);
        }

        static bool ArtistHasTracks(string json)
        {
            var data = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            var tracks = data != null && data.ContainsKey("tracks") ? data["tracks"] as object[] : null;
            return tracks != null && tracks.Length > 0;
        }

        static bool ArtistUserMatches(Dictionary<string, object> user, string name)
        {
            var username = user.ContainsKey("username") && user["username"] != null ? Convert.ToString(user["username"]) : "";
            var permalink = user.ContainsKey("permalink") && user["permalink"] != null ? Convert.ToString(user["permalink"]) : "";
            return ArtistNamesMatch(username, name) || ArtistNamesMatch(permalink, name);
        }

        static bool ArtistNamesMatch(string candidate, string requested)
        {
            return string.Equals(
                (candidate ?? "").Trim().TrimEnd('.').Trim(),
                (requested ?? "").Trim().TrimEnd('.').Trim(),
                StringComparison.OrdinalIgnoreCase);
        }

        static string GetArtist(string id)
        {
            var uid = id.Substring(3);
            var list = new List<Dictionary<string, object>>();
            Dictionary<string, object> profile = null;

            try
            {
                profile = new JavaScriptSerializer().DeserializeObject(
                    ScGet("https://api-v2.soundcloud.com/users/" + uid)) as Dictionary<string, object>;
            }
            catch (WebException error)
            {
                Trace.TraceWarning("Could not load SoundCloud artist profile " + id + ": " + error.Message);
            }

            try
            {
                var json = ScGet("https://api-v2.soundcloud.com/users/" + uid + "/tracks?limit=200");
                var root = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
                var results = root != null && root.ContainsKey("collection") ? root["collection"] as object[] : null;
                if (results != null)
                {
                    foreach (var item in results)
                    {
                        var d = item as Dictionary<string, object>;
                        if (d == null) continue;
                        if (profile == null && d.ContainsKey("user"))
                            profile = d["user"] as Dictionary<string, object>;
                        if (d.ContainsKey("streamable") && d["streamable"] is bool && !(bool)d["streamable"]) continue;
                        list.Add(MapTrack(d));
                    }
                }
            }
            catch (WebException error)
            {
                Trace.TraceWarning("Could not load tracks for SoundCloud artist " + id + ": " + error.Message);
            }

            if (profile == null)
            {
                var usersJson = ScGet("https://api-v2.soundcloud.com/search/users?q=" + Uri.EscapeDataString(uid) + "&limit=5");
                var usersRoot = new JavaScriptSerializer().DeserializeObject(usersJson) as Dictionary<string, object>;
                var users = usersRoot != null && usersRoot.ContainsKey("collection") ? usersRoot["collection"] as object[] : null;
                if (users != null)
                {
                    foreach (var item in users)
                    {
                        var u = item as Dictionary<string, object>;
                        if (u != null && u.ContainsKey("id") && Convert.ToString(u["id"]) == uid)
                        {
                            profile = u;
                            break;
                        }
                    }
                }
            }

            if (list.Count == 0 && profile != null)
            {
                var username = profile.ContainsKey("username") && profile["username"] != null
                    ? Convert.ToString(profile["username"])
                    : "";
                if (!string.IsNullOrEmpty(username))
                {
                    try
                    {
                        var searchJson = ScGet("https://api-v2.soundcloud.com/search/tracks?q=" + Uri.EscapeDataString(username) + "&limit=50");
                        var searchRoot = new JavaScriptSerializer().DeserializeObject(searchJson) as Dictionary<string, object>;
                        var searchResults = searchRoot != null && searchRoot.ContainsKey("collection")
                            ? searchRoot["collection"] as object[]
                            : null;
                        if (searchResults != null)
                        {
                            foreach (var item in searchResults)
                            {
                                var track = item as Dictionary<string, object>;
                                var user = track != null && track.ContainsKey("user")
                                    ? track["user"] as Dictionary<string, object>
                                    : null;
                                if (user == null || !user.ContainsKey("id") ||
                                    Convert.ToString(user["id"]) != uid ||
                                    (track.ContainsKey("streamable") && track["streamable"] is bool && !(bool)track["streamable"]))
                                    continue;
                                list.Add(MapTrack(track));
                            }
                        }
                    }
                    catch (WebException error)
                    {
                        Trace.TraceWarning("Could not search tracks for SoundCloud artist " + id + ": " + error.Message);
                    }
                }
            }

            var artist = new Dictionary<string, object>();
            artist["id"] = id;
            artist["name"] = profile != null && profile.ContainsKey("username") && profile["username"] != null ? profile["username"] : "";
            artist["avatar"] = profile != null && profile.ContainsKey("avatar_url") ? profile["avatar_url"] as string : "";
            artist["followers"] = profile != null && profile.ContainsKey("followers_count") ? Convert.ToInt64(profile["followers_count"]) : 0;
            artist["trackCount"] = profile != null && profile.ContainsKey("track_count") ? Convert.ToInt64(profile["track_count"]) : list.Count;

            var outData = new Dictionary<string, object>();
            outData["artist"] = artist;
            outData["tracks"] = list;
            return new JavaScriptSerializer().Serialize(outData);
        }

        static Dictionary<string, object> MapTrack(Dictionary<string, object> data)
        {
            var user = data.ContainsKey("user") ? data["user"] as Dictionary<string, object> : null;
            var artwork = data.ContainsKey("artwork_url") ? data["artwork_url"] as string : null;
            if (string.IsNullOrEmpty(artwork) && user != null && user.ContainsKey("avatar_url"))
                artwork = user["avatar_url"] as string;
            if (!string.IsNullOrEmpty(artwork))
                artwork = artwork.Replace("-large.", "-t500x500.");
            var id = data.ContainsKey("id") ? Convert.ToInt64(data["id"]) : 0;

            var track = new Dictionary<string, object>();
            track["id"] = "sc:" + id;
            track["title"] = data.ContainsKey("title") && data["title"] != null ? data["title"] : "";
            track["artist"] = user != null && user.ContainsKey("username") ? user["username"] as string : "";
            track["artistId"] = user != null && user.ContainsKey("id") ? "sc:" + Convert.ToInt64(user["id"]) : "";
            track["avatar"] = user != null && user.ContainsKey("avatar_url") ? user["avatar_url"] as string : "";
            track["artwork"] = artwork;
            var duration = data.ContainsKey("full_duration") && data["full_duration"] != null ? Convert.ToInt64(data["full_duration"]) : 0;
            if (duration <= 0 && data.ContainsKey("duration") && data["duration"] != null)
                duration = Convert.ToInt64(data["duration"]);
            track["duration"] = duration / 1000;
            track["preview"] = "";
            track["stream"] = "/api/stream?id=" + Uri.EscapeDataString("sc:" + id);
            track["source"] = "soundcloud";
            return track;
        }

        static Dictionary<string, object> SpotifyEntity(string type, string id)
        {
            var html = HttpGet("https://open.spotify.com/embed/" + type + "/" + id);
            var match = Regex.Match(html, @"<script id=""__NEXT_DATA__""[^>]*>(.*?)</script>", RegexOptions.Singleline);
            if (!match.Success) throw new InvalidOperationException("Spotify did not return public embed data.");

            var serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = 8 * 1024 * 1024;
            var root = serializer.DeserializeObject(match.Groups[1].Value) as Dictionary<string, object>;
            var props = root != null && root.ContainsKey("props") ? root["props"] as Dictionary<string, object> : null;
            var pageProps = props != null && props.ContainsKey("pageProps") ? props["pageProps"] as Dictionary<string, object> : null;
            var state = pageProps != null && pageProps.ContainsKey("state") ? pageProps["state"] as Dictionary<string, object> : null;
            var data = state != null && state.ContainsKey("data") ? state["data"] as Dictionary<string, object> : null;
            var entity = data != null && data.ContainsKey("entity") ? data["entity"] as Dictionary<string, object> : null;
            if (entity == null) throw new InvalidOperationException("Spotify playlist or track is unavailable.");
            return entity;
        }

        static string SpotifyArtwork(Dictionary<string, object> entity)
        {
            var cover = entity.ContainsKey("coverArt") ? entity["coverArt"] as Dictionary<string, object> : null;
            var sources = cover != null && cover.ContainsKey("sources") ? cover["sources"] as object[] : null;
            if (sources == null)
            {
                var identity = entity.ContainsKey("visualIdentity") ? entity["visualIdentity"] as Dictionary<string, object> : null;
                sources = identity != null && identity.ContainsKey("image") ? identity["image"] as object[] : null;
            }
            if (sources == null) return "";
            string artwork = "";
            foreach (var item in sources)
            {
                var source = item as Dictionary<string, object>;
                if (source != null && source.ContainsKey("url") && source["url"] != null)
                    artwork = source["url"] as string;
            }
            return artwork;
        }

        static Dictionary<string, object> MapSpotifyTrack(Dictionary<string, object> data, string artwork)
        {
            var id = data.ContainsKey("id") ? data["id"] as string : null;
            if (string.IsNullOrEmpty(id) && data.ContainsKey("uri"))
            {
                var match = Regex.Match(data["uri"] as string ?? "", @"^spotify:track:([A-Za-z0-9]{22})$");
                if (match.Success) id = match.Groups[1].Value;
            }
            if (string.IsNullOrEmpty(id)) return null;

            var artists = data.ContainsKey("artists") ? data["artists"] as object[] : null;
            var artistNames = new List<string>();
            var artistIds = new List<string>();
            if (artists != null)
            {
                foreach (var item in artists)
                {
                    var artist = item as Dictionary<string, object>;
                    if (artist == null || !artist.ContainsKey("name") || artist["name"] == null) continue;
                    artistNames.Add(Convert.ToString(artist["name"]));
                    var artistId = artist.ContainsKey("id") && artist["id"] != null
                        ? Convert.ToString(artist["id"])
                        : "";
                    if (string.IsNullOrEmpty(artistId) && artist.ContainsKey("uri") && artist["uri"] != null)
                    {
                        var artistUri = Regex.Match(Convert.ToString(artist["uri"]), @"^spotify:artist:([A-Za-z0-9]{22})$");
                        if (artistUri.Success) artistId = artistUri.Groups[1].Value;
                    }
                    artistIds.Add(artistId);
                }
            }
            if (artistNames.Count == 0 && data.ContainsKey("subtitle") && data["subtitle"] != null)
                artistNames.Add(Convert.ToString(data["subtitle"]));

            var previewData = data.ContainsKey("audioPreview") ? data["audioPreview"] as Dictionary<string, object> : null;
            var preview = previewData != null && previewData.ContainsKey("url") ? previewData["url"] as string : "";
            var track = new Dictionary<string, object>();
            track["id"] = "spotify:" + id;
            track["title"] = data.ContainsKey("title") && data["title"] != null ? data["title"] :
                data.ContainsKey("name") && data["name"] != null ? data["name"] : "";
            track["artist"] = string.Join(", ", artistNames.ToArray());
            track["artistNames"] = artistNames;
            track["artistIds"] = artistIds;
            track["artwork"] = artwork;
            track["duration"] = data.ContainsKey("duration") ? Convert.ToInt64(data["duration"]) / 1000 : 0;
            track["preview"] = preview ?? "";
            track["stream"] = "";
            track["source"] = "spotify";
            return track;
        }

        static string GetSpotifyTrack(string id)
        {
            var entity = SpotifyEntity("track", id);
            var track = MapSpotifyTrack(entity, SpotifyArtwork(entity));
            if (track == null) throw new InvalidOperationException("Spotify track metadata is missing.");
            return new JavaScriptSerializer().Serialize(track);
        }

        static string GetSpotifyPlaylist(string id)
        {
            var entity = SpotifyEntity("playlist", id);
            var trackData = entity.ContainsKey("trackList") ? entity["trackList"] as object[] : null;
            var artwork = SpotifyArtwork(entity);
            var tracks = new List<Dictionary<string, object>>();
            if (trackData != null)
            {
                foreach (var item in trackData)
                {
                    var data = item as Dictionary<string, object>;
                    if (data == null) continue;
                    var track = MapSpotifyTrack(data, artwork);
                    if (track != null) tracks.Add(track);
                }
            }

            var playlist = new Dictionary<string, object>();
            playlist["id"] = "spotify:" + id;
            playlist["title"] = entity.ContainsKey("title") && entity["title"] != null ? entity["title"] : "";
            playlist["artist"] = entity.ContainsKey("subtitle") && entity["subtitle"] != null ? entity["subtitle"] : "";
            playlist["artwork"] = artwork;
            playlist["source"] = "spotify";
            playlist["tracks"] = tracks;
            return new JavaScriptSerializer().Serialize(playlist);
        }

        static string GetProgressiveStreamUrl(string id)
        {
            lock (streamUrlLock)
            {
                StreamEntry cached;
                if (streamUrls.TryGetValue(id, out cached) && (DateTime.UtcNow - cached.At).TotalMinutes < 5)
                    return cached.Url;
            }

            var trackId = id.StartsWith("sc:", StringComparison.Ordinal) ? id.Substring(3) : id;
            var json = ScGet("https://api-v2.soundcloud.com/tracks/" + Uri.EscapeDataString(trackId));
            var serializer = new JavaScriptSerializer();
            var track = serializer.DeserializeObject(json) as Dictionary<string, object>;
            var media = track != null && track.ContainsKey("media") ? track["media"] as Dictionary<string, object> : null;
            var transcodings = media != null && media.ContainsKey("transcodings") ? media["transcodings"] as object[] : null;
            if (transcodings == null) return null;

            foreach (var item in transcodings)
            {
                var transcoding = item as Dictionary<string, object>;
                var format = transcoding != null && transcoding.ContainsKey("format")
                    ? transcoding["format"] as Dictionary<string, object>
                    : null;
                if (format == null || !string.Equals(format.ContainsKey("protocol") ? format["protocol"] as string : null,
                    "progressive", StringComparison.OrdinalIgnoreCase))
                    continue;

                var url = Resolve(transcoding.ContainsKey("url") ? transcoding["url"] as string : null);
                if (string.IsNullOrEmpty(url)) continue;
                lock (streamUrlLock)
                {
                    if (streamUrls.Count >= 100)
                    {
                        string oldest = null;
                        var oldestAt = DateTime.MaxValue;
                        foreach (var entry in streamUrls)
                            if (entry.Value.At < oldestAt) { oldestAt = entry.Value.At; oldest = entry.Key; }
                        if (oldest != null) streamUrls.Remove(oldest);
                    }
                    streamUrls[id] = new StreamEntry { Url = url, At = DateTime.UtcNow };
                }
                return url;
            }
            return null;
        }

        static bool ProxyProgressiveTrack(NetworkStream client, string id, string range)
        {
            var url = GetProgressiveStreamUrl(id);
            if (string.IsNullOrEmpty(url)) return false;

            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.UserAgent = ScUa;
            request.Timeout = 15000;
            request.ReadWriteTimeout = 15000;
            request.AllowAutoRedirect = true;
            ApplyUpstreamRange(request, range);

            using (var response = (HttpWebResponse)request.GetResponse())
            {
                var headers = new StringBuilder();
                headers.Append("HTTP/1.1 ").Append((int)response.StatusCode).Append(" ").Append(StatusText((int)response.StatusCode)).Append("\r\n");
                headers.Append("Content-Type: ").Append(response.ContentType).Append("\r\n");
                if (response.ContentLength >= 0)
                    headers.Append("Content-Length: ").Append(response.ContentLength).Append("\r\n");
                if (!string.IsNullOrEmpty(response.Headers["Content-Range"]))
                    headers.Append("Content-Range: ").Append(response.Headers["Content-Range"]).Append("\r\n");
                headers.Append("Accept-Ranges: bytes\r\nConnection: close\r\n\r\n");
                var headerBytes = Encoding.ASCII.GetBytes(headers.ToString());
                client.Write(headerBytes, 0, headerBytes.Length);

                using (var source = response.GetResponseStream())
                {
                    var buffer = new byte[65536];
                    int count;
                    while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                        client.Write(buffer, 0, count);
                }
                client.Flush();
            }
            return true;
        }

        static void ApplyUpstreamRange(HttpWebRequest request, string range)
        {
            if (string.IsNullOrEmpty(range)) return;
            var match = Regex.Match(range, @"^bytes=(\d*)-(\d*)$");
            if (!match.Success) return;
            long start;
            long end;
            var hasStart = long.TryParse(match.Groups[1].Value, out start);
            var hasEnd = long.TryParse(match.Groups[2].Value, out end);
            if (hasStart && hasEnd) request.AddRange(start, end);
            else if (hasStart) request.AddRange(start);
            else if (hasEnd && end > 0) request.AddRange(-end);
        }

        static byte[] FetchTrack(string id, out string mime)
        {
            mime = "audio/mpeg";
            lock (cacheLock)
            {
                CacheEntry hit;
                if (cache.TryGetValue(id, out hit) && (DateTime.UtcNow - hit.At).TotalMinutes < 10)
                {
                    mime = hit.Mime;
                    return hit.Data;
                }
            }

            var trackId = id;
            var colon = trackId.IndexOf(':');
            if (colon >= 0) trackId = trackId.Substring(colon + 1);

            var json = ScGet("https://api-v2.soundcloud.com/tracks/" + Uri.EscapeDataString(trackId));
            var ser = new JavaScriptSerializer();
            var tr = ser.DeserializeObject(json) as Dictionary<string, object>;
            if (tr == null || !tr.ContainsKey("media")) return null;
            var media = tr["media"] as Dictionary<string, object>;
            var trans = media != null && media.ContainsKey("transcodings") ? media["transcodings"] as object[] : null;
            if (trans == null) return null;

            byte[] data = null;

            foreach (var t in trans)
            {
                var td = t as Dictionary<string, object>;
                if (td == null) continue;
                var fmt = td.ContainsKey("format") ? td["format"] as Dictionary<string, object> : null;
                if (fmt == null || fmt["protocol"] as string != "progressive") continue;
                var resolved = Resolve(td["url"] as string);
                if (resolved == null) continue;
                try { data = HttpBytes(resolved); }
                catch { data = null; }
                if (data != null) { mime = "audio/mpeg"; break; }
            }

            if (data == null)
            {
                foreach (var t in trans)
                {
                    var td = t as Dictionary<string, object>;
                    if (td == null) continue;
                    var resolved = Resolve(td["url"] as string);
                    if (resolved == null) continue;
                    try { data = FetchHls(resolved); }
                    catch { data = null; }
                    if (data != null) { mime = "audio/mp4"; break; }
                }
            }

            if (data == null) return null;

            lock (cacheLock)
            {
                if (cache.Count >= 25)
                {
                    string oldest = null;
                    var oldestAt = DateTime.MaxValue;
                    foreach (var kv in cache)
                        if (kv.Value.At < oldestAt) { oldestAt = kv.Value.At; oldest = kv.Key; }
                    if (oldest != null) cache.Remove(oldest);
                }
                cache[id] = new CacheEntry { Data = data, Mime = mime, At = DateTime.UtcNow };
            }
            return data;
        }

        static string Resolve(string transcodingUrl)
        {
            if (string.IsNullOrEmpty(transcodingUrl)) return null;
            var json = ScGet(transcodingUrl);
            var d = new JavaScriptSerializer().DeserializeObject(json) as Dictionary<string, object>;
            return d != null && d.ContainsKey("url") ? d["url"] as string : null;
        }

        static byte[] FetchHls(string playlistUrl)
        {
            var text = HttpGet(playlistUrl);
            var baseDir = playlistUrl.Substring(0, playlistUrl.LastIndexOf('/') + 1);
            string map = null;
            var segs = new List<string>();

            foreach (var raw in text.Split('\n'))
            {
                var l = raw.Trim();
                if (l.Length == 0) continue;
                if (l.StartsWith("#EXT-X-MAP:"))
                {
                    var m = Regex.Match(l, "URI=\"([^\"]+)\"");
                    if (m.Success) map = m.Groups[1].Value;
                }
                else if (!l.StartsWith("#"))
                {
                    if (!l.StartsWith("http")) l = baseDir + l;
                    segs.Add(l);
                }
            }

            if (segs.Count == 0) return null;

            var urls = new List<string>();
            if (map != null) urls.Add(map);
            urls.AddRange(segs);

            var parts = new byte[urls.Count][];
            Parallel.For(0, urls.Count, delegate(int i)
            {
                parts[i] = HttpBytes(urls[i]);
            });

            using (var ms = new MemoryStream())
            {
                foreach (var b in parts)
                {
                    if (b == null) return null;
                    ms.Write(b, 0, b.Length);
                }
                return ms.ToArray();
            }
        }

        static string OEmbed(string target)
        {
            if (!IsSpotifyTrackUrl(target))
                throw new ArgumentException("A Spotify track URL is required.", "target");
            var url = "https://open.spotify.com/oembed?url=" + Uri.EscapeDataString(target);
            var json = HttpGet(url);
            var ser = new JavaScriptSerializer();
            var d = ser.DeserializeObject(json) as Dictionary<string, object>;
            var outData = new Dictionary<string, object>();
            outData["title"] = d != null && d.ContainsKey("title") ? d["title"] : "";
            outData["artwork"] = d != null && d.ContainsKey("thumbnail_url") ? d["thumbnail_url"] : "";
            return ser.Serialize(outData);
        }

        static string SearchYouTubeVideos(string term)
        {
            var apiKey = GetYouTubeApiKey();
            if (String.IsNullOrWhiteSpace(apiKey))
                throw new InvalidOperationException("YouTube Data API key is not configured.");

            var url = "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&videoSyndicated=true" +
                "&safeSearch=moderate&maxResults=10&q=" + Uri.EscapeDataString(term);
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.UserAgent = "Villife/1.0";
            request.Accept = "application/json";
            request.Headers["X-Goog-Api-Key"] = apiKey;
            request.Timeout = 15000;
            request.ReadWriteTimeout = 15000;

            var serializer = new JavaScriptSerializer();
            var output = new Dictionary<string, object>();
            var videos = new List<Dictionary<string, object>>();
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                var data = serializer.DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
                var items = data != null && data.ContainsKey("items") ? data["items"] as object[] : null;
                if (items != null)
                {
                    foreach (var rawItem in items)
                    {
                        var item = rawItem as Dictionary<string, object>;
                        var idData = item != null && item.ContainsKey("id") ? item["id"] as Dictionary<string, object> : null;
                        var snippet = item != null && item.ContainsKey("snippet") ? item["snippet"] as Dictionary<string, object> : null;
                        var videoId = idData != null && idData.ContainsKey("videoId") ? Convert.ToString(idData["videoId"]) : "";
                        if (!Regex.IsMatch(videoId, @"^[A-Za-z0-9_-]{11}$")) continue;

                        var thumbnails = snippet != null && snippet.ContainsKey("thumbnails")
                            ? snippet["thumbnails"] as Dictionary<string, object>
                            : null;
                        object thumbnail = null;
                        if (thumbnails != null)
                        {
                            foreach (var size in new[] { "maxres", "standard", "high", "medium", "default" })
                            {
                                var image = thumbnails.ContainsKey(size) ? thumbnails[size] as Dictionary<string, object> : null;
                                if (image != null && image.ContainsKey("url"))
                                {
                                    thumbnail = image["url"];
                                    break;
                                }
                            }
                        }

                        videos.Add(new Dictionary<string, object>
                        {
                            { "id", videoId },
                            { "title", snippet != null && snippet.ContainsKey("title") ? snippet["title"] : "" },
                            { "thumbnail", thumbnail ?? "" }
                        });
                    }
                }
            }

            output["videos"] = videos;
            return serializer.Serialize(output);
        }

        static string GetYouTubeApiKey()
        {
            var apiKey = Environment.GetEnvironmentVariable("VILLIFE_YOUTUBE_API_KEY");
            return String.IsNullOrWhiteSpace(apiKey)
                ? Environment.GetEnvironmentVariable("VILIFE_YOUTUBE_API_KEY")
                : apiKey;
        }

        public static void MigrateLegacyProfile(string target)
        {
            try
            {
                var legacy = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Velo.exe.WebView2");
                if (!Directory.Exists(legacy) || Directory.Exists(target))
                    return;
                var parent = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(parent))
                    Directory.CreateDirectory(parent);
                Directory.Move(legacy, target);
            }
            catch (Exception error)
            {
                Trace.TraceWarning("Could not move the legacy Villife profile: " + error);
            }
        }

        static string Escape(string s)
        {
            if (s == null) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
        }
    }

    class MainForm : Form
    {
        WebView2 web;
        readonly DiscordRpcClient discordRpc;
        NotifyIcon trayIcon;
        Form trayPopup;
        PictureBox trayArtwork;
        Label trayTitle;
        Label trayArtist;
        Button trayPlayPauseButton;
        System.Windows.Forms.Timer trayAnimation;
        WebClient trayArtworkClient;
        readonly Dictionary<string, Bitmap> trayGlyphs = new Dictionary<string, Bitmap>();
        Image trayArtworkImage;
        Rectangle trayPopupBounds;
        int trayArtworkRequestId;
        bool trayPopupOpening;
        string trayArtworkUrl = "";
        string storagePath;
        Rectangle normalBounds;
        Size normalMinimumSize;
        bool normalWasMaximized;
        bool miniWindowActive;
        Point dragAnchor = Point.Empty;
        const int WmNcHitTest = 0x0084;
        const int WmNcLButtonDown = 0x00A1;
        const int WmGetMinMaxInfo = 0x0024;
        const int DwmwaWindowCornerPreference = 33;
        const int DwmCornerRound = 2;
        const int HtClient = 1;
        const int HtCaption = 2;
        const int CaptionHeight = 42;
        const int WindowControlsWidth = 160;

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool DestroyIcon(IntPtr handle);

        public MainForm(int port)
        {
            discordRpc = new DiscordRpcClient();
            storagePath = Program.BrowserProfileDir();
            Program.MigrateLegacyProfile(storagePath);
            Text = "Villife";
            Size = new Size(1423, 768);
            MinimumSize = new Size(960, 600);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(13, 13, 15);

            try
            {
                var iconPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "villife.ico");
                if (File.Exists(iconPath)) Icon = new Icon(iconPath);
            }
            catch
            {
            }

            web = new WebView2();
            web.CreationProperties = new Microsoft.Web.WebView2.WinForms.CoreWebView2CreationProperties
            {
                UserDataFolder = storagePath
            };
            web.Dock = DockStyle.Fill;
            web.CoreWebView2InitializationCompleted += delegate(object sender, Microsoft.Web.WebView2.Core.CoreWebView2InitializationCompletedEventArgs e)
            {
                if (!e.IsSuccess)
                {
                    Trace.TraceError("WebView2 initialization failed: " + e.InitializationException);
                    return;
                }

                var settings = web.CoreWebView2.Settings;
                settings.AreDefaultContextMenusEnabled = false;
                settings.AreBrowserAcceleratorKeysEnabled = false;
                settings.AreDevToolsEnabled = false;
                settings.IsStatusBarEnabled = false;
                web.CoreWebView2.WebMessageReceived += delegate(object messageSender, Microsoft.Web.WebView2.Core.CoreWebView2WebMessageReceivedEventArgs messageArgs)
                {
                    var message = messageArgs.TryGetWebMessageAsString();
                    if (DiscordRpcClient.IsPresenceMessage(message))
                    {
                        discordRpc.Update(message);
                        return;
                    }
                    const string youtubePrefix = "villife-youtube:";
                    if (message != null && message.StartsWith(youtubePrefix, StringComparison.Ordinal))
                    {
                        var videoId = message.Substring(youtubePrefix.Length);
                        if (Regex.IsMatch(videoId, @"^[A-Za-z0-9_-]{11}$"))
                            OpenYouTubeVideo(videoId);
                        return;
                    }
                    const string windowPrefix = "villife-window:";
                    if (message != null && message.StartsWith(windowPrefix, StringComparison.Ordinal))
                    {
                        var command = message.Substring(windowPrefix.Length);
                        switch (command)
                        {
                            case "minimize":
                                WindowState = FormWindowState.Minimized;
                                return;
                            case "maximize":
                                WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
                                return;
                            case "close":
                                Close();
                                return;
                            case "open-storage":
                                OpenStorageLocation();
                                return;
                            case "website":
                                OpenWebsite();
                                return;
                            case "drag-start":
                                dragAnchor = new Point(Cursor.Position.X - Left, Cursor.Position.Y - Top);
                                return;
                            case "drag-move":
                                if (dragAnchor == Point.Empty) return;
                                var pointer = Cursor.Position;
                                Location = new Point(pointer.X - dragAnchor.X, pointer.Y - dragAnchor.Y);
                                return;
                            case "drag-end":
                                dragAnchor = Point.Empty;
                                return;
                            case "mini-window":
                                SetMiniWindow(true);
                                return;
                            case "normal-window":
                                SetMiniWindow(false);
                                return;
                        }
                    }
                    const string trayPrefix = "villife-tray:";
                    if (message != null && message.StartsWith(trayPrefix, StringComparison.Ordinal))
                    {
                        try
                        {
                            var payload = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                                message.Substring(trayPrefix.Length));
                            UpdateTrayTrack(payload);
                        }
                        catch (Exception error)
                        {
                            Trace.TraceError("Could not update the tray player: " + error);
                        }
                        return;
                    }
                    const string exportPrefix = "villife-export:";
                    if (message == null || !message.StartsWith(exportPrefix, StringComparison.Ordinal)) return;

                    using (var dialog = new SaveFileDialog())
                    {
                        dialog.Title = "Экспорт библиотеки Villife";
                        dialog.Filter = "JSON-файл (*.json)|*.json";
                        dialog.DefaultExt = "json";
                        dialog.AddExtension = true;
                        dialog.FileName = "villife-library-" + DateTime.Now.ToString("yyyy-MM-dd") + ".json";
                        if (dialog.ShowDialog(this) != DialogResult.OK) return;

                        try
                        {
                            File.WriteAllText(dialog.FileName, message.Substring(exportPrefix.Length), new UTF8Encoding(false));
                        }
                        catch (Exception error)
                        {
                            Trace.TraceError("Could not export the Villife library: " + error);
                            MessageBox.Show(this, "Не удалось сохранить файл библиотеки.\n\n" + error.Message, "Villife", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        }
                    }
                };
            };
            Controls.Add(web);
            InitializeTray();

            Load += delegate
            {
                web.Source = new Uri("http://127.0.0.1:" + port + "/");
            };
        }

        void InitializeTray()
        {
            trayPopup = new Form
            {
                FormBorderStyle = FormBorderStyle.None,
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                TopMost = true,
                BackColor = Color.FromArgb(25, 26, 29),
                Size = new Size(328, 124),
                Opacity = 0,
                AccessibleName = "Villife playback controls"
            };
            trayPopup.Paint += delegate(object sender, PaintEventArgs e)
            {
                using (var pen = new Pen(Color.FromArgb(52, 53, 58)))
                    e.Graphics.DrawRectangle(pen, 0, 0, trayPopup.Width - 1, trayPopup.Height - 1);
            };
            trayArtwork = new PictureBox
            {
                Location = new Point(16, 20),
                Size = new Size(48, 48),
                SizeMode = PictureBoxSizeMode.Zoom,
                BackColor = Color.FromArgb(38, 39, 43),
                Image = CreateTrayPlaceholder(),
                AccessibleName = "Album artwork"
            };
            trayArtworkImage = trayArtwork.Image;
            trayPopup.Controls.Add(trayArtwork);
            trayTitle = new Label
            {
                AutoEllipsis = true,
                Location = new Point(76, 19),
                Size = new Size(190, 22),
                ForeColor = Color.FromArgb(239, 239, 241),
                Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
                Text = "Villife"
            };
            trayArtist = new Label
            {
                AutoEllipsis = true,
                Location = new Point(76, 41),
                Size = new Size(218, 20),
                ForeColor = Color.FromArgb(156, 156, 162),
                Font = new Font("Segoe UI", 8.5f),
                Text = " "
            };
            trayPopup.Controls.Add(trayTitle);
            trayPopup.Controls.Add(trayArtist);
            var quitButton = new Button
            {
                Text = "Quit",
                Location = new Point(276, 12),
                Size = new Size(42, 24),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(25, 26, 29),
                ForeColor = Color.FromArgb(156, 156, 162),
                Font = new Font("Segoe UI", 8f),
                Cursor = Cursors.Hand
            };
            quitButton.FlatAppearance.BorderSize = 0;
            quitButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(53, 39, 41);
            quitButton.Click += delegate { Close(); };
            trayPopup.Controls.Add(quitButton);
            trayPopup.Controls.Add(CreateTrayButton("previous", new Point(106, 76), delegate { ExecutePlayerCommand("previous"); }));
            trayPlayPauseButton = CreateTrayButton("play", new Point(150, 76), delegate { ExecutePlayerCommand("togglePlay"); });
            trayPopup.Controls.Add(trayPlayPauseButton);
            trayPopup.Controls.Add(CreateTrayButton("next", new Point(194, 76), delegate { ExecutePlayerCommand("next"); }));
            trayAnimation = new System.Windows.Forms.Timer { Interval = 15 };
            trayAnimation.Tick += AnimateTrayPopup;
            trayPopup.Deactivate += delegate { HideTrayPopup(); };

            trayIcon = new NotifyIcon
            {
                Text = "Villife",
                Icon = CreateTrayIcon(),
                Visible = true
            };
            trayIcon.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left || e.Button == MouseButtons.Right)
                    ShowTrayPopup();
            };
            trayIcon.DoubleClick += delegate
            {
                HideTrayPopup();
                ShowFromTray();
            };
        }

        Button CreateTrayButton(string glyph, Point location, EventHandler click)
        {
            var button = new Button
            {
                Location = location,
                Size = new Size(36, 32),
                FlatStyle = FlatStyle.Flat,
                BackColor = Color.FromArgb(25, 26, 29),
                ForeColor = Color.FromArgb(156, 156, 162),
                Image = GetTrayGlyph(glyph),
                Cursor = Cursors.Hand,
                TabStop = false,
                AccessibleName = glyph == "previous" ? "Previous" :
                    glyph == "next" ? "Next" :
                    glyph == "pause" ? "Pause" : "Play"
            };
            button.FlatAppearance.BorderSize = 0;
            button.FlatAppearance.MouseOverBackColor = Color.FromArgb(46, 47, 52);
            button.Click += click;
            return button;
        }

        static Image CreateTrayPlaceholder()
        {
            var image = new Bitmap(48, 48);
            using (var graphics = Graphics.FromImage(image))
            using (var pen = new Pen(Color.FromArgb(156, 156, 162), 2f))
            using (var brush = new SolidBrush(Color.FromArgb(156, 156, 162)))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.Clear(Color.FromArgb(38, 39, 43));
                graphics.DrawEllipse(pen, 14, 12, 8, 8);
                graphics.DrawEllipse(pen, 27, 24, 8, 8);
                graphics.DrawLine(pen, 20, 17, 20, 33);
                graphics.DrawLine(pen, 33, 17, 33, 29);
                graphics.FillPolygon(brush, new[] { new Point(20, 17), new Point(34, 14), new Point(34, 17) });
            }
            return image;
        }

        void ShowTrayPopup()
        {
            if (trayPopup.Visible) return;
            var workingArea = Screen.FromPoint(Cursor.Position).WorkingArea;
            trayPopupBounds = new Rectangle(
                workingArea.Right - trayPopup.Width - 10,
                workingArea.Bottom - trayPopup.Height - 10,
                trayPopup.Width,
                trayPopup.Height);
            trayPopup.Bounds = new Rectangle(trayPopupBounds.X, trayPopupBounds.Y + 10, trayPopupBounds.Width, trayPopupBounds.Height);
            trayPopup.Opacity = 0;
            trayPopupOpening = true;
            trayPopup.Show();
            trayPopup.Activate();
            trayAnimation.Start();
        }

        void HideTrayPopup()
        {
            if (trayPopup == null || !trayPopup.Visible || !trayPopupOpening) return;
            trayPopupOpening = false;
            trayAnimation.Start();
        }

        void AnimateTrayPopup(object sender, EventArgs e)
        {
            if (trayPopupOpening)
            {
                trayPopup.Opacity = Math.Min(1, trayPopup.Opacity + 0.14);
                trayPopup.Top = Math.Max(trayPopupBounds.Top, trayPopup.Top - 2);
                if (trayPopup.Opacity >= 1 && trayPopup.Top <= trayPopupBounds.Top)
                    trayAnimation.Stop();
                return;
            }
            trayPopup.Opacity = Math.Max(0, trayPopup.Opacity - 0.2);
            trayPopup.Top = Math.Min(trayPopupBounds.Top + 10, trayPopup.Top + 2);
            if (trayPopup.Opacity <= 0)
            {
                trayAnimation.Stop();
                trayPopup.Hide();
            }
        }

        void UpdateTrayTrack(Dictionary<string, object> payload)
        {
            if (payload == null) return;
            trayTitle.Text = TrayValue(payload, "title", "Villife");
            trayArtist.Text = TrayValue(payload, "artist", "");
            var playingValue = payload.ContainsKey("playing") && payload["playing"] is bool && (bool)payload["playing"];
            trayPlayPauseButton.Image = GetTrayGlyph(playingValue ? "pause" : "play");
            trayPlayPauseButton.AccessibleName = playingValue ? "Pause" : "Play";
            var tooltip = (trayTitle.Text + (trayArtist.Text.Length > 0 ? " — " + trayArtist.Text : "")).Trim();
            trayIcon.Text = tooltip.Length > 63 ? tooltip.Substring(0, 60) + "..." : tooltip;
            var artworkUrl = TrayValue(payload, "artwork", "");
            if (artworkUrl == trayArtworkUrl) return;
            trayArtworkUrl = artworkUrl;
            if (trayArtworkClient != null) trayArtworkClient.CancelAsync();
            var requestId = ++trayArtworkRequestId;
            Uri artworkUri;
            if (!Uri.TryCreate(artworkUrl, UriKind.Absolute, out artworkUri) ||
                (artworkUri.Scheme != Uri.UriSchemeHttp && artworkUri.Scheme != Uri.UriSchemeHttps) ||
                !IsAllowedTrayArtworkHost(artworkUri.Host))
            {
                SetTrayArtwork(CreateTrayPlaceholder());
                return;
            }
            SetTrayArtwork(CreateTrayPlaceholder());
            var client = new WebClient();
            trayArtworkClient = client;
            client.DownloadDataCompleted += delegate(object sender, DownloadDataCompletedEventArgs e)
            {
                client.Dispose();
                if (trayArtworkClient == client) trayArtworkClient = null;
                if (requestId != trayArtworkRequestId || e.Cancelled || e.Error != null)
                {
                    if (e.Error != null) Trace.TraceError("Could not load tray artwork: " + e.Error);
                    return;
                }
                try
                {
                    if (e.Result.Length > 4 * 1024 * 1024)
                        throw new InvalidDataException("Tray artwork exceeds the 4 MB limit.");
                    using (var stream = new MemoryStream(e.Result))
                    using (var source = Image.FromStream(stream))
                        SetTrayArtwork(new Bitmap(source));
                }
                catch (Exception error)
                {
                    Trace.TraceError("Could not decode tray artwork: " + error);
                }
            };
            client.DownloadDataAsync(artworkUri);
        }

        static bool IsAllowedTrayArtworkHost(string host)
        {
            var domains = new[] { "sndcdn.com", "scdn.co", "ytimg.com", "spotify.com", "spotifycdn.com" };
            foreach (var domain in domains)
                if (host.Equals(domain, StringComparison.OrdinalIgnoreCase) ||
                    host.EndsWith("." + domain, StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;
        }

        static string TrayValue(Dictionary<string, object> payload, string key, string fallback)
        {
            object value;
            return payload.TryGetValue(key, out value) && value is string
                ? (string)value
                : fallback;
        }

        Bitmap GetTrayGlyph(string glyph)
        {
            Bitmap image;
            if (trayGlyphs.TryGetValue(glyph, out image)) return image;
            image = CreateTrayGlyph(glyph);
            trayGlyphs.Add(glyph, image);
            return image;
        }

        void SetTrayArtwork(Image image)
        {
            var previous = trayArtworkImage;
            trayArtworkImage = image;
            trayArtwork.Image = image;
            if (previous != null) previous.Dispose();
        }

        static Bitmap CreateTrayGlyph(string glyph)
        {
            var image = new Bitmap(16, 16);
            using (var graphics = Graphics.FromImage(image))
            using (var brush = new SolidBrush(Color.FromArgb(156, 156, 162)))
            using (var pen = new Pen(Color.FromArgb(156, 156, 162), 1.5f))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                if (glyph == "previous")
                {
                    graphics.DrawLine(pen, 4, 3, 4, 13);
                    graphics.FillPolygon(brush, new[] { new Point(5, 8), new Point(13, 3), new Point(13, 13) });
                }
                else if (glyph == "next")
                {
                    graphics.DrawLine(pen, 12, 3, 12, 13);
                    graphics.FillPolygon(brush, new[] { new Point(11, 8), new Point(3, 3), new Point(3, 13) });
                }
                else if (glyph == "pause")
                {
                    graphics.FillRectangle(brush, 4, 3, 4, 10);
                    graphics.FillRectangle(brush, 10, 3, 4, 10);
                }
                else
                {
                    graphics.FillPolygon(brush, new[] { new Point(5, 3), new Point(13, 8), new Point(5, 13) });
                }
            }
            return image;
        }

        static Icon CreateTrayIcon()
        {
            using (var image = new Bitmap(32, 32))
            using (var graphics = Graphics.FromImage(image))
            using (var pen = new Pen(Color.FromArgb(156, 156, 162), 4.2f))
            {
                graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                graphics.DrawLines(pen, new[] { new Point(5, 8), new Point(11, 24), new Point(16, 15), new Point(21, 24), new Point(27, 8) });
                var handle = image.GetHicon();
                try
                {
                    using (var source = Icon.FromHandle(handle))
                        return (Icon)source.Clone();
                }
                finally
                {
                    DestroyIcon(handle);
                }
            }
        }

        void ShowFromTray()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Show();
            Activate();
        }


        [StructLayout(LayoutKind.Sequential)]
        struct MINMAXINFO
        {
            public Point ptReserved;
            public Point ptMaxSize;
            public Point ptMaxPosition;
            public Point ptMinTrackSize;
            public Point ptMaxTrackSize;
        }

        void ApplyRoundedCorners()
        {
            try
            {
                int round = 2;
                DwmSetWindowAttribute(Handle, 33, ref round, 4);
            }
            catch
            {
            }
        }

        void SetMiniWindow(bool mini)
        {
            if (mini)
            {
                if (miniWindowActive) return;
                normalWasMaximized = WindowState == FormWindowState.Maximized;
                normalBounds = Bounds;
                normalMinimumSize = MinimumSize;
                WindowState = FormWindowState.Normal;
                MinimumSize = new Size(480, 128);
                Size = new Size(520, 156);
                StartPosition = FormStartPosition.Manual;
                Bounds = new Rectangle(
                    Screen.FromControl(this).WorkingArea.Right - Width - 20,
                    Screen.FromControl(this).WorkingArea.Bottom - Height - 20,
                    Width,
                    Height);
                miniWindowActive = true;
                ApplyRoundedCorners();
                return;
            }

            if (!miniWindowActive) return;
            MinimumSize = normalMinimumSize;
            if (normalWasMaximized)
                WindowState = FormWindowState.Maximized;
            else
                Bounds = normalBounds;
            miniWindowActive = false;
        }

        void ExecutePlayerCommand(string command)
        {
            if (web == null || web.CoreWebView2 == null) return;
            web.CoreWebView2.ExecuteScriptAsync("window.villifeNative && window.villifeNative." + command + "()");
        }

        void OpenStorageLocation()
        {
            try
            {
                if (!Directory.Exists(storagePath)) Directory.CreateDirectory(storagePath);
                Process.Start("explorer.exe", "\"" + storagePath + "\"");
            }
            catch (Exception error)
            {
                Trace.TraceError("Could not open the Villife storage location: " + error);
                MessageBox.Show(this, "Не удалось открыть папку данных Villife.\n\n" + error.Message, "Villife", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        static void OpenWebsite()
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "https://villife.hs.vc/",
                    UseShellExecute = true
                });
            }
            catch (Exception error)
            {
                Trace.TraceError("Could not open the Villife website: " + error);
            }
        }

        static void OpenYouTubeVideo(string videoId)
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = "https://www.youtube.com/watch?v=" + videoId,
                    UseShellExecute = true
                });
            }
            catch (Exception error)
            {
                Trace.TraceError("Could not open the YouTube video: " + error);
            }
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            discordRpc.Dispose();
            if (trayIcon != null)
            {
                trayIcon.Visible = false;
                trayIcon.Icon.Dispose();
                trayIcon.Dispose();
            }
            trayArtworkRequestId++;
            if (trayArtworkClient != null) trayArtworkClient.CancelAsync();
            if (trayAnimation != null)
            {
                trayAnimation.Stop();
                trayAnimation.Dispose();
            }
            if (trayPopup != null) trayPopup.Dispose();
            if (trayArtworkImage != null) trayArtworkImage.Dispose();
            foreach (var glyph in trayGlyphs.Values) glyph.Dispose();
            base.OnFormClosed(e);
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmGetMinMaxInfo)
            {
                var info = (MINMAXINFO)Marshal.PtrToStructure(message.LParam, typeof(MINMAXINFO));
                var area = Screen.FromControl(this).WorkingArea;
                info.ptMaxPosition = new Point(area.Left, area.Top);
                info.ptMaxSize = new Point(area.Width, area.Height);
                info.ptMaxTrackSize = new Point(area.Width, area.Height);
                Marshal.StructureToPtr(info, message.LParam, true);
                message.Result = IntPtr.Zero;
                return;
            }
            if (message.Msg == WmNcHitTest && WindowState == FormWindowState.Normal)
            {
                base.WndProc(ref message);
                var point = PointToClient(Cursor.Position);
                if (point.Y < CaptionHeight && point.X < ClientSize.Width - WindowControlsWidth)
                    message.Result = (IntPtr)HtCaption;
                else
                    message.Result = (IntPtr)HtClient;
                return;
            }

            base.WndProc(ref message);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int on = 1;
                DwmSetWindowAttribute(Handle, 20, ref on, 4);
                DwmSetWindowAttribute(Handle, 32, ref on, 4);
                int round = 2;
                DwmSetWindowAttribute(Handle, 33, ref round, 4);
            }
            catch
            {
            }
        }
    }
}

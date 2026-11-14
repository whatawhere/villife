using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace Vilife
{
    sealed class DiscordPresenceState
    {
        public string TrackId;
        public string Title;
        public string Artist;
        public string Artwork;
        public long PositionMilliseconds;
        public long DurationMilliseconds;
        public long ObservedAtMilliseconds;
        public bool IsPlaying;

        public string Signature
        {
            get
            {
                return String.Join("|", new string[]
                {
                    TrackId ?? "",
                    Title ?? "",
                    Artist ?? "",
                    Artwork ?? "",
                    IsPlaying ? "1" : "0",
                    (PositionMilliseconds / 100).ToString(),
                    DurationMilliseconds.ToString()
                });
            }
        }
    }

    sealed class DiscordRpcClient : IDisposable
    {
        const string ApplicationId = "1568764693965971518";
        const string MessagePrefix = "vilife-discord:";
        const int MaximumPayloadLength = 1024 * 1024;
        static readonly long UnixEpochTicks = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).Ticks;
        readonly object stateLock = new object();
        readonly AutoResetEvent stateChanged = new AutoResetEvent(false);
        readonly Thread worker;
        readonly string pipeNamePrefix;
        DiscordPresenceState state;
        bool disposed;

        public DiscordRpcClient()
            : this("discord-ipc-")
        {
        }

        internal DiscordRpcClient(string pipeNamePrefix)
        {
            this.pipeNamePrefix = pipeNamePrefix;
            worker = new Thread(Run);
            worker.IsBackground = true;
            worker.Name = "Vilife Discord RPC";
            worker.Start();
        }

        public static bool IsPresenceMessage(string message)
        {
            return message != null && message.StartsWith(MessagePrefix, StringComparison.Ordinal);
        }

        public void Update(string message)
        {
            try
            {
                var data = new JavaScriptSerializer().DeserializeObject(message.Substring(MessagePrefix.Length)) as Dictionary<string, object>;
                if (data == null) throw new InvalidDataException("Discord presence payload must be a JSON object.");
                object activeValue;
                bool active = data.TryGetValue("active", out activeValue) && activeValue is bool && (bool)activeValue;
                DiscordPresenceState next = null;
                if (active)
                {
                    next = new DiscordPresenceState
                    {
                        TrackId = ReadString(data, "trackId", 256),
                        Title = ReadString(data, "title", 128),
                        Artist = ReadString(data, "artist", 128),
                        Artwork = ReadArtwork(data),
                        PositionMilliseconds = ReadMilliseconds(data, "positionMs"),
                        DurationMilliseconds = ReadMilliseconds(data, "durationMs"),
                        ObservedAtMilliseconds = ReadMilliseconds(data, "observedAt"),
                        IsPlaying = ReadBoolean(data, "isPlaying")
                    };
                    if (String.IsNullOrWhiteSpace(next.Title))
                    {
                        next = null;
                    }
                    else
                    {
                        if (next.DurationMilliseconds <= 0) next.PositionMilliseconds = 0;
                        else next.PositionMilliseconds = Math.Max(0, Math.Min(next.PositionMilliseconds, next.DurationMilliseconds));
                    }
                }

                lock (stateLock)
                {
                    if (disposed) return;
                    state = next;
                }
                stateChanged.Set();
            }
            catch (Exception error)
            {
                Trace.TraceError("Could not read Discord presence update: " + error);
            }
        }

        static string ReadString(Dictionary<string, object> data, string key, int maximumLength)
        {
            object value;
            if (!data.TryGetValue(key, out value) || value == null) return "";
            string text = Convert.ToString(value);
            text = text.Replace("\r", " ").Replace("\n", " ").Trim();
            return text.Length <= maximumLength ? text : text.Substring(0, maximumLength);
        }

        static string ReadArtwork(Dictionary<string, object> data)
        {
            string artwork = ReadString(data, "artwork", 2048);
            Uri uri;
            return Uri.TryCreate(artwork, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps
                ? uri.AbsoluteUri
                : "";
        }

        static long ReadMilliseconds(Dictionary<string, object> data, string key)
        {
            object value;
            if (!data.TryGetValue(key, out value) || value == null) return 0;
            try
            {
                double number = Convert.ToDouble(value, System.Globalization.CultureInfo.InvariantCulture);
                if (Double.IsNaN(number) || Double.IsInfinity(number) || number < 0) return 0;
                return number >= Int64.MaxValue ? Int64.MaxValue : (long)number;
            }
            catch (FormatException)
            {
                return 0;
            }
            catch (InvalidCastException)
            {
                return 0;
            }
        }

        static bool ReadBoolean(Dictionary<string, object> data, string key)
        {
            object value;
            return data.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        DiscordPresenceState CurrentState()
        {
            lock (stateLock) return state;
        }

        bool IsDisposed()
        {
            lock (stateLock) return disposed;
        }

        void Run()
        {
            NamedPipeClientStream pipe = null;
            AutoResetEvent connectionLost = new AutoResetEvent(false);
            Thread reader = null;
            string lastSignature = null;
            bool activitySent = false;

            while (true)
            {
                DiscordPresenceState current = CurrentState();
                if (pipe == null)
                {
                    if (current == null)
                    {
                        if (IsDisposed()) break;
                        stateChanged.WaitOne(2000);
                        continue;
                    }
                    pipe = Connect();
                    if (pipe == null)
                    {
                        stateChanged.WaitOne(2000);
                        continue;
                    }

                    try
                    {
                        WriteFrame(pipe, 0, "{\"v\":1,\"client_id\":\"" + ApplicationId + "\"}");
                        Trace.TraceInformation("Discord RPC handshake sent.");
                        ReadFrame(pipe);
                        Trace.TraceInformation("Discord RPC handshake accepted.");
                        connectionLost.Reset();
                        NamedPipeClientStream connectedPipe = pipe;
                        reader = new Thread(() => ReadResponses(connectedPipe, connectionLost));
                        reader.IsBackground = true;
                        reader.Name = "Vilife Discord RPC reader";
                        reader.Start();
                        lastSignature = null;
                        activitySent = false;
                    }
                    catch (Exception error)
                    {
                        Trace.TraceError("Discord RPC handshake failed: " + error.Message);
                        pipe.Dispose();
                        pipe = null;
                        stateChanged.WaitOne(2000);
                        continue;
                    }
                }

                current = CurrentState();
                string signature = current == null ? "" : current.Signature;
                if (current == null ? activitySent : signature != lastSignature)
                {
                    try
                    {
                        Trace.TraceInformation("Discord RPC activity update sent.");
                        string activityMessage = BuildActivityMessage(current);
                        WriteFrame(pipe, 1, activityMessage);
                        lastSignature = signature;
                        activitySent = current != null;
                    }
                    catch (Exception error)
                    {
                        Trace.TraceError("Discord RPC update failed: " + error.Message);
                        pipe.Dispose();
                        pipe = null;
                        reader = null;
                        activitySent = false;
                        continue;
                    }
                }

                if (IsDisposed() && current == null)
                {
                    pipe.Dispose();
                    pipe = null;
                    break;
                }

                int signaled = WaitHandle.WaitAny(new WaitHandle[] { stateChanged, connectionLost }, 2000);
                if (signaled == 1 || (pipe != null && !pipe.IsConnected))
                {
                    if (pipe != null) pipe.Dispose();
                    pipe = null;
                    reader = null;
                    activitySent = false;
                    lastSignature = null;
                }
            }

            if (pipe != null) pipe.Dispose();
            connectionLost.Dispose();
        }

        NamedPipeClientStream Connect()
        {
            for (int index = 0; index < 10; index++)
            {
                if (IsDisposed()) return null;
                var candidate = new NamedPipeClientStream(".", pipeNamePrefix + index, PipeDirection.InOut, PipeOptions.Asynchronous);
                try
                {
                    candidate.Connect(250);
                    return candidate;
                }
                catch (TimeoutException)
                {
                    candidate.Dispose();
                }
                catch (IOException)
                {
                    candidate.Dispose();
                }
            }
            return null;
        }

        void ReadResponses(NamedPipeClientStream pipe, AutoResetEvent connectionLost)
        {
            try
            {
                while (pipe.IsConnected) ReadFrameAsync(pipe);
            }
            catch (Exception error)
            {
                if (!IsDisposed()) Trace.TraceInformation("Discord RPC connection closed: " + error.Message);
                connectionLost.Set();
            }
        }

        static void WriteFrame(Stream stream, int opcode, string message)
        {
            byte[] payload = Encoding.UTF8.GetBytes(message);
            if (payload.Length > MaximumPayloadLength) throw new InvalidDataException("Discord RPC payload is too large.");
            byte[] header = new byte[8];
            Buffer.BlockCopy(BitConverter.GetBytes(opcode), 0, header, 0, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(payload.Length), 0, header, 4, 4);
            stream.Write(header, 0, header.Length);
            stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }

        static string ReadFrame(Stream stream)
        {
            byte[] header = ReadExact(stream, 8);
            int payloadLength = BitConverter.ToInt32(header, 4);
            if (payloadLength < 0 || payloadLength > MaximumPayloadLength)
                throw new InvalidDataException("Discord RPC returned an invalid payload length.");
            return Encoding.UTF8.GetString(ReadExact(stream, payloadLength));
        }

        static string ReadFrameAsync(Stream stream)
        {
            byte[] header = ReadExactAsync(stream, 8);
            int payloadLength = BitConverter.ToInt32(header, 4);
            if (payloadLength < 0 || payloadLength > MaximumPayloadLength)
                throw new InvalidDataException("Discord RPC returned an invalid payload length.");
            return Encoding.UTF8.GetString(ReadExactAsync(stream, payloadLength));
        }

        static byte[] ReadExact(Stream stream, int length)
        {
            byte[] buffer = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                int read = stream.Read(buffer, offset, length - offset);
                if (read <= 0) throw new EndOfStreamException("Discord RPC closed the pipe.");
                offset += read;
            }
            return buffer;
        }

        static byte[] ReadExactAsync(Stream stream, int length)
        {
            byte[] buffer = new byte[length];
            int offset = 0;
            while (offset < length)
            {
                IAsyncResult pending = stream.BeginRead(buffer, offset, length - offset, null, null);
                int read = stream.EndRead(pending);
                if (read <= 0) throw new EndOfStreamException("Discord RPC closed the pipe.");
                offset += read;
            }
            return buffer;
        }

        string BuildActivityMessage(DiscordPresenceState current)
        {
            var args = new Dictionary<string, object>();
            args["pid"] = Process.GetCurrentProcess().Id;
            if (current == null)
            {
                args["activity"] = null;
            }
            else
            {
                var activity = new Dictionary<string, object>();
                activity["type"] = 2;
                activity["details"] = current.Title;
                activity["state"] = current.Artist;

                var assets = new Dictionary<string, object>();
                if (!String.IsNullOrEmpty(current.Artwork)) assets["large_image"] = current.Artwork;
                if (assets.Count > 0) activity["assets"] = assets;

                if (current.IsPlaying && current.DurationMilliseconds > 0)
                {
                    long now = (DateTime.UtcNow.Ticks - UnixEpochTicks) / TimeSpan.TicksPerMillisecond;
                    long observedAt = current.ObservedAtMilliseconds > 0
                        ? Math.Min(current.ObservedAtMilliseconds, now + 5000)
                        : now;
                    long start = observedAt - current.PositionMilliseconds;
                    activity["timestamps"] = new Dictionary<string, object>
                    {
                        { "start", start },
                        { "end", start + current.DurationMilliseconds }
                    };
                }
                args["activity"] = activity;
            }

            var request = new Dictionary<string, object>();
            request["cmd"] = "SET_ACTIVITY";
            request["args"] = args;
            request["nonce"] = Guid.NewGuid().ToString("N");
            return new JavaScriptSerializer().Serialize(request);
        }

        public void Dispose()
        {
            lock (stateLock)
            {
                if (disposed) return;
                disposed = true;
                state = null;
            }
            stateChanged.Set();
            if (Thread.CurrentThread != worker && worker.Join(6000)) stateChanged.Dispose();
        }
    }

}

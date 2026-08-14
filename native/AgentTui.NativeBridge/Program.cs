using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

namespace AgentTui.NativeBridge
{
    internal static class Program
    {
        private const uint EventMoveSizeStart = 0x000A;
        private const uint EventMoveSizeEnd = 0x000B;
        private const uint WineventOutOfContext = 0x0000;
        private const uint WineventSkipOwnProcess = 0x0002;
        private const uint WmQuit = 0x0012;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
        private static readonly object OutputLock = new object();
        private static WinEventDelegate callback;
        private static IntPtr hookStart;
        private static IntPtr hookEnd;
        private static IntPtr activeWindow;
        private static Timer sampler;
        private static uint mainThreadId;
        private static IntPtr lastDroppedWindow;
        private static DateTime lastDropAtUtc;
        private static bool lastDropInterrupted;
        private static bool lastDropClosed;

        private delegate void WinEventDelegate(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime);

        [StructLayout(LayoutKind.Sequential)]
        private struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Point { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Msg { public IntPtr Hwnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Pt; }
        [StructLayout(LayoutKind.Sequential)]
        private struct Input { public uint Type; public InputUnion Union; }
        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion { [FieldOffset(0)] public KeyboardInput Keyboard; }
        [StructLayout(LayoutKind.Sequential)]
        private struct KeyboardInput { public ushort VirtualKey; public ushort Scan; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }

        [DllImport("user32.dll")]
        private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventDelegate callback, uint processId, uint threadId, uint flags);
        [DllImport("user32.dll")]
        private static extern bool UnhookWinEvent(IntPtr hook);
        [DllImport("user32.dll")]
        private static extern int GetMessage(out Msg message, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")]
        private static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")]
        private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")]
        private static extern bool GetCursorPos(out Point point);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
        [DllImport("user32.dll")]
        private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")]
        private static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

        private static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                Console.WriteLine("{\"type\":\"self-test\",\"protocolVersion\":1,\"platform\":\"windows\"}");
                return 0;
            }
            if (args.Length != 0) return 2;

            Console.OutputEncoding = new UTF8Encoding(false);
            mainThreadId = GetCurrentThreadId();
            callback = OnWindowEvent;
            hookStart = SetWinEventHook(EventMoveSizeStart, EventMoveSizeStart, IntPtr.Zero, callback, 0, 0, WineventOutOfContext | WineventSkipOwnProcess);
            hookEnd = SetWinEventHook(EventMoveSizeEnd, EventMoveSizeEnd, IntPtr.Zero, callback, 0, 0, WineventOutOfContext | WineventSkipOwnProcess);
            if (hookStart == IntPtr.Zero || hookEnd == IntPtr.Zero) return 3;

            var stdinWatcher = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null) HandleCommand(line);
                }
                catch { }
                PostThreadMessage(mainThreadId, WmQuit, UIntPtr.Zero, IntPtr.Zero);
            });
            stdinWatcher.IsBackground = true;
            stdinWatcher.Start();

            Msg message;
            while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) { }
            StopSampler();
            if (hookStart != IntPtr.Zero) UnhookWinEvent(hookStart);
            if (hookEnd != IntPtr.Zero) UnhookWinEvent(hookEnd);
            return 0;
        }

        private static void OnWindowEvent(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint eventThread, uint eventTime)
        {
            if (objectId != 0 || childId != 0 || hwnd == IntPtr.Zero) return;
            hwnd = GetAncestor(hwnd, 2);
            var facts = Inspect(hwnd);
            if (facts == null) return;
            if (eventType == EventMoveSizeStart)
            {
                activeWindow = hwnd;
                Emit("move-start", facts);
                StartSampler();
            }
            else if (eventType == EventMoveSizeEnd && hwnd == activeWindow)
            {
                StopSampler();
                Emit("move-end", facts);
                lastDroppedWindow = hwnd;
                lastDropAtUtc = DateTime.UtcNow;
                lastDropInterrupted = false;
                lastDropClosed = false;
                activeWindow = IntPtr.Zero;
            }
        }

        private static void StartSampler()
        {
            StopSampler();
            sampler = new Timer(_ =>
            {
                var hwnd = activeWindow;
                if (hwnd == IntPtr.Zero) return;
                var facts = Inspect(hwnd);
                if (facts == null) { StopSampler(); return; }
                Emit("move-update", facts);
            }, null, 60, 60);
        }

        private static void StopSampler()
        {
            var current = sampler;
            sampler = null;
            if (current != null) current.Dispose();
        }

        private static Dictionary<string, object> Inspect(IntPtr hwnd)
        {
            uint pid;
            if (GetWindowThreadProcessId(hwnd, out pid) == 0 || pid == 0) return null;
            string processName;
            try { processName = Process.GetProcessById((int)pid).ProcessName; } catch { return null; }
            var classBuffer = new StringBuilder(256);
            GetClassName(hwnd, classBuffer, classBuffer.Capacity);
            var className = classBuffer.ToString();
            if (!processName.Equals("WindowsTerminal", StringComparison.OrdinalIgnoreCase)
                && !processName.Equals("conhost", StringComparison.OrdinalIgnoreCase)
                && !className.Equals("ConsoleWindowClass", StringComparison.OrdinalIgnoreCase)) return null;
            Rect rect;
            Point cursor;
            if (!GetWindowRect(hwnd, out rect) || !GetCursorPos(out cursor)) return null;
            var titleBuffer = new StringBuilder(1024);
            GetWindowText(hwnd, titleBuffer, titleBuffer.Capacity);
            var structure = InspectStructure(hwnd, processName);
            return new Dictionary<string, object>
            {
                { "hwnd", "0x" + hwnd.ToInt64().ToString("X") },
                { "processId", (int)pid },
                { "processName", processName },
                { "className", className },
                { "title", titleBuffer.ToString() },
                { "rect", new Dictionary<string, object> { { "left", rect.Left }, { "top", rect.Top }, { "right", rect.Right }, { "bottom", rect.Bottom } } },
                { "cursor", new Dictionary<string, object> { { "x", cursor.X }, { "y", cursor.Y } } }
                ,{ "tabCount", structure.Item1 }
                ,{ "paneCount", structure.Item2 }
                ,{ "structureVerified", structure.Item3 }
            };
        }

        private static Tuple<int, int, bool> InspectStructure(IntPtr hwnd, string processName)
        {
            if (!processName.Equals("WindowsTerminal", StringComparison.OrdinalIgnoreCase)) return Tuple.Create(0, 0, false);
            try
            {
                var root = AutomationElement.FromHandle(hwnd);
                var tabs = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem)).Count;
                var documents = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Document)).Count;
                return Tuple.Create(tabs, documents, tabs == 1 && documents == 1);
            }
            catch { return Tuple.Create(0, 0, false); }
        }

        private static void HandleCommand(string line)
        {
            Dictionary<string, object> command;
            try { command = Json.Deserialize<Dictionary<string, object>>(line); }
            catch { return; }
            object rawType;
            object rawRequestId;
            if (!command.TryGetValue("type", out rawType) || !command.TryGetValue("requestId", out rawRequestId)) return;
            var type = rawType as string;
            var requestId = rawRequestId as string;
            if (String.IsNullOrWhiteSpace(type) || String.IsNullOrWhiteSpace(requestId)) return;
            if (type != "send-graceful-interrupt" && type != "close-source-window")
            {
                EmitCommandResult(requestId, false, "unsupported-command");
                return;
            }
            object rawHwnd;
            object rawPid;
            object rawTitle;
            long handleValue;
            if (!command.TryGetValue("hwnd", out rawHwnd) || !TryParseHwnd(rawHwnd as string, out handleValue)
                || !command.TryGetValue("expectedProcessId", out rawPid) || !(rawPid is int)
                || !command.TryGetValue("expectedTitle", out rawTitle) || !(rawTitle is string))
            {
                EmitCommandResult(requestId, false, "invalid-command");
                return;
            }
            var hwnd = new IntPtr(handleValue);
            var facts = Inspect(hwnd);
            var commandAge = DateTime.UtcNow - lastDropAtUtc;
            var maximumAge = type == "close-source-window"
                ? TimeSpan.FromSeconds(30)
                : TimeSpan.FromSeconds(8);
            if (facts == null || hwnd != lastDroppedWindow || commandAge > maximumAge
                || (int)facts["processId"] != (int)rawPid || (string)facts["title"] != (string)rawTitle
                || !(bool)facts["structureVerified"]
                || (type == "send-graceful-interrupt" && lastDropInterrupted)
                || (type == "close-source-window" && (!lastDropInterrupted || lastDropClosed))
                || (type == "send-graceful-interrupt" && GetForegroundWindow() != hwnd))
            {
                EmitCommandResult(requestId, false, "window-verification-failed");
                return;
            }
            if (type == "close-source-window")
            {
                var closed = PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
                if (closed) lastDropClosed = true;
                EmitCommandResult(requestId, closed, "close-failed");
                return;
            }
            var inputs = new[] {
                Key(0x11, false), Key(0x43, false), Key(0x43, true), Key(0x11, true)
            };
            var interrupted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == inputs.Length;
            if (interrupted) lastDropInterrupted = true;
            EmitCommandResult(requestId, interrupted, "input-failed");
        }

        private static Input Key(ushort key, bool up)
        {
            return new Input { Type = 1, Union = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = up ? 2U : 0U } } };
        }

        private static bool TryParseHwnd(string value, out long result)
        {
            result = 0;
            return !String.IsNullOrEmpty(value) && value.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                && Int64.TryParse(value.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out result);
        }

        private static void EmitCommandResult(string requestId, bool ok, string failureReason)
        {
            var result = new Dictionary<string, object> { { "type", "command-result" }, { "requestId", requestId }, { "ok", ok } };
            if (!ok) result["reason"] = failureReason;
            lock (OutputLock) { Console.WriteLine(Json.Serialize(result)); Console.Out.Flush(); }
        }

        private static void Emit(string type, Dictionary<string, object> facts)
        {
            facts["type"] = type;
            lock (OutputLock)
            {
                Console.WriteLine(Json.Serialize(facts));
                Console.Out.Flush();
            }
        }
    }
}

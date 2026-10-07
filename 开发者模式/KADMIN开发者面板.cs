/* ============================================================
   KADMIN 开发者面板（本地窗口版 · 独立 exe）
   ------------------------------------------------------------
   - 原生 WinForms 小窗口（不是浏览器页面、不是脚本宿主）
   - 内置最小 HTTP 服务（127.0.0.1:7788，TcpListener，无需管理员）：
       游戏里的开发者桥每 0.5 秒来 /poll 取命令，并把回执 / 卡表 / 局面 POST 回来
   - 功能：指定卡（正常卡池 / 衍生卡 / JM / 老兵形态）加入手牌 · 加入战场 · 置于卡组顶
           无限指挥点 · 我方/敌方总部免疫伤害 · 跳过 AI 下个回合 · 双方总部回满 · 直接获胜
   - 卡顿/闪退的两条根治（2026-09-17 用户报「太卡、闪退」）：
       ① HTTP 收发全部丢到**后台线程**，UI 线程只做「取队列 + 刷新」；
       ② 全局异常兜底（ThreadException / UnhandledException）——绝不静默闪退，出错弹窗 + 落盘日志；
          列表重建/选中项刷新都加了 try/catch 与下标边界检查。
   - 编译：csc.exe /target:winexe /out:KADMIN开发者面板.exe /r:System.Windows.Forms.dll
           /r:System.Drawing.dll /r:System.Web.Extensions.dll /r:System.Core.dll KADMIN开发者面板.cs
   说明：为兼容 .NET Framework 自带的 csc（C# 5），全文不用字符串插值/空条件运算符。
   ============================================================ */
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class DevPanel
{
    static int PORT = 7788;
    static bool selfTest = false;
    static string logFile = Path.Combine(Path.GetTempPath(), "kadmin-dev-panel.log");
    static readonly JavaScriptSerializer JSON = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };

    /* ---- 共享状态（后台线程写 / UI 线程读，用 gate 保护，UI 只在版本号变化时重建界面） ---- */
    static readonly object gate = new object();
    static List<Dictionary<string, object>> cards = new List<Dictionary<string, object>>();
    static int cardsVer = 0;
    static string stateJson = "";
    static int stateVer = 0;
    static DateTime lastPoll = DateTime.MinValue;
    static readonly List<Dictionary<string, object>> cmds = new List<Dictionary<string, object>>();
    static readonly ConcurrentQueue<string> logQueue = new ConcurrentQueue<string>();
    static readonly ConcurrentQueue<Dictionary<string, object>> cmdQueue = new ConcurrentQueue<Dictionary<string, object>>();

    static TcpListener listener = null;
    static Thread serverThread = null;
    static volatile bool serverStop = false;

    static Form form;
    static Label lblStatus, lblState, lblCards;
    static TextBox txtSearch, txtLog;
    static ComboBox cmbGroup;
    static ListBox list;
    static Button btnHand, btnBoard, btnDeck, btnClear, btnSkip, btnHeal, btnWin;
    static CheckBox cbKredit, cbImmuneP, cbImmuneA;
    static List<Dictionary<string, object>> shown = new List<Dictionary<string, object>>();
    static int uiCardsVer = -1, uiStateVer = -1;
    static string lastStatusText = "", lastStateText = "";

    [STAThread]
    static void Main(string[] args)
    {
        foreach (string a in args)
        {
            string s = (a ?? "").ToLower();
            if (s == "-selftest") selfTest = true;
            if (s.StartsWith("-port=")) { int p; if (int.TryParse(s.Substring(6), out p)) PORT = p; }
        }
        /* ---- 全局异常兜底：绝不静默闪退 ---- */
        Application.ThreadException += delegate (object s, ThreadExceptionEventArgs e) { ReportCrash(e.Exception, "界面线程"); };
        AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e) { ReportCrash(e.ExceptionObject as Exception, "后台线程"); };
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        BuildUi();

        try
        {
            listener = new TcpListener(IPAddress.Loopback, PORT);
            listener.Start();
            serverThread = new Thread(ServerLoop);
            serverThread.IsBackground = true;
            serverThread.Start();
            AddLog("开发者面板已启动：http://127.0.0.1:" + PORT + "（" + (selfTest ? "自检模式" : "正常模式") + "）");
            AddLog("请在浏览器里打开 KADMIN-卡兹铭刻.html；连上后这里会自动收到卡牌索引。");
        }
        catch (Exception e)
        {
            MessageBox.Show("端口 " + PORT + " 启动失败：" + e.Message + "\n\n可能已经开着一个面板，或端口被占用。", "KADMIN 开发者面板");
        }

        System.Windows.Forms.Timer pump = new System.Windows.Forms.Timer();
        pump.Interval = 100;                       // 只管刷界面，不做任何网络 IO
        pump.Tick += delegate { try { UiTick(); } catch (Exception e) { ReportCrash(e, "界面刷新"); } };
        pump.Start();

        form.FormClosing += delegate { StopServer(); };
        if (selfTest) StartSelfTest();
        Application.Run(form);
        StopServer();
    }

    static void ReportCrash(Exception e, string where)
    {
        try { File.AppendAllText(logFile + ".err", "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + where + "：" + (e == null ? "未知" : e.ToString()) + "\r\n", new UTF8Encoding(false)); } catch { }
        try { MessageBox.Show("开发者面板出错了（" + where + "）：\n" + (e == null ? "未知错误" : e.Message) + "\n\n详情见 " + logFile + ".err\n面板会继续运行。", "KADMIN 开发者面板"); } catch { }
    }
    static void StopServer()
    {
        serverStop = true;
        try { if (listener != null) listener.Stop(); } catch { }
    }

    /* ---------------- 日志（UI 线程排队写，避免后台线程碰控件） ---------------- */
    static void AddLog(string msg)
    {
        logQueue.Enqueue("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg);
        if (selfTest) { try { File.AppendAllText(logFile, "[" + DateTime.Now.ToString("HH:mm:ss") + "] " + msg + "\r\n", new UTF8Encoding(false)); } catch { } }
    }
    static void DrainLog()
    {
        StringBuilder sb = new StringBuilder();
        string line; int n = 0;
        while (n < 40 && logQueue.TryDequeue(out line)) { sb.Append(line).Append("\r\n"); n++; }
        if (sb.Length == 0) return;
        string old = txtLog.Text;
        string add = sb.ToString();
        if (old.Length > 24000) old = old.Substring(0, 12000);
        txtLog.Text = add + old;      // 新的在上
    }

    static void NewCmd(string cmd, Dictionary<string, object> cargs)
    {
        Dictionary<string, object> c = new Dictionary<string, object>();
        c["id"] = 0;                  // 真正的 id 由后台线程发号（保证与游戏轮询顺序一致）
        c["cmd"] = cmd;
        c["args"] = cargs;
        cmdQueue.Enqueue(c);
        string shownArgs = (cargs == null || cargs.Count == 0) ? "" : (" " + JSON.Serialize(cargs));
        AddLog("→ " + cmd + shownArgs);
    }

    /* ---------------- 界面 ---------------- */
    static Label NewLabel(string text, int x, int y, int w, int h)
    {
        Label l = new Label();
        l.Text = text; l.Location = new Point(x, y); l.Size = new Size(w, h);
        l.ForeColor = Color.FromArgb(200, 210, 220);
        form.Controls.Add(l);
        return l;
    }
    static Button NewBtn(string text, int x, int y, int w, int h)
    {
        Button b = new Button();
        b.Text = text; b.Location = new Point(x, y); b.Size = new Size(w, h);
        b.FlatStyle = FlatStyle.Flat;
        b.BackColor = Color.FromArgb(35, 43, 53);
        b.ForeColor = Color.FromArgb(230, 237, 243);
        b.FlatAppearance.BorderColor = Color.FromArgb(70, 84, 100);
        form.Controls.Add(b);
        return b;
    }
    static void BuildUi()
    {
        form = new Form();
        form.Text = "KADMIN 开发者面板";
        form.Size = new Size(640, 800);
        form.MinimumSize = new Size(440, 540);
        form.StartPosition = FormStartPosition.Manual;
        form.Location = new Point(60, 60);
        form.BackColor = Color.FromArgb(18, 22, 28);
        form.ForeColor = Color.FromArgb(230, 237, 243);
        try { form.Font = new Font("Microsoft YaHei UI", 9f); } catch { }

        lblStatus = NewLabel("游戏：○ 离线（等 KADMIN 打开）", 12, 8, 600, 20);
        lblState = NewLabel("回合 —　我方 —　敌方 —　指挥点 —", 12, 30, 600, 20);
        lblCards = NewLabel("卡牌（连接后自动拉取：正常卡池 / 衍生卡 / JM / 老兵形态）", 12, 58, 600, 18);

        txtSearch = new TextBox();
        txtSearch.Location = new Point(12, 80); txtSearch.Size = new Size(440, 24);
        txtSearch.BackColor = Color.FromArgb(12, 16, 22); txtSearch.ForeColor = form.ForeColor;
        txtSearch.BorderStyle = BorderStyle.FixedSingle;
        txtSearch.TextChanged += delegate { try { FillList(); } catch (Exception e) { ReportCrash(e, "搜索"); } };
        form.Controls.Add(txtSearch);

        cmbGroup = new ComboBox();
        cmbGroup.Location = new Point(462, 80); cmbGroup.Size = new Size(150, 24);
        cmbGroup.DropDownStyle = ComboBoxStyle.DropDownList;
        cmbGroup.Items.AddRange(new object[] { "全部", "正常卡池", "衍生卡", "JM", "老兵形态" });
        cmbGroup.SelectedIndex = 0;
        cmbGroup.BackColor = Color.FromArgb(12, 16, 22); cmbGroup.ForeColor = form.ForeColor;
        cmbGroup.SelectedIndexChanged += delegate { try { FillList(); } catch (Exception e) { ReportCrash(e, "筛选"); } };
        form.Controls.Add(cmbGroup);

        list = new ListBox();
        list.Location = new Point(12, 110); list.Size = new Size(600, 300);
        list.BackColor = Color.FromArgb(12, 16, 22); list.ForeColor = form.ForeColor;
        list.BorderStyle = BorderStyle.FixedSingle; list.IntegralHeight = false;
        list.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        list.SelectedIndexChanged += delegate { try { UpdateButtons(); } catch (Exception e) { ReportCrash(e, "选择"); } };
        form.Controls.Add(list);

        btnHand = NewBtn("加入手牌", 12, 420, 130, 30);
        btnBoard = NewBtn("加入战场", 150, 420, 130, 30);
        btnDeck = NewBtn("置于卡组顶", 288, 420, 130, 30);
        btnClear = NewBtn("清空搜索", 426, 420, 100, 30);
        btnHand.Enabled = false; btnBoard.Enabled = false; btnDeck.Enabled = false;
        btnHand.Click += delegate { SendCard("addHand"); };
        btnBoard.Click += delegate { SendCard("addBoard"); };
        btnDeck.Click += delegate { SendCard("addDeck"); };
        btnClear.Click += delegate { txtSearch.Text = ""; try { FillList(); } catch { } };

        NewLabel("作弊开关", 12, 458, 200, 18);
        cbKredit = new CheckBox();
        cbKredit.Text = "无限指挥点"; cbKredit.Location = new Point(12, 478); cbKredit.Size = new Size(120, 22);
        cbKredit.ForeColor = form.ForeColor; cbKredit.CheckedChanged += delegate { try { PushFlags(); } catch { } };
        form.Controls.Add(cbKredit);
        cbImmuneP = new CheckBox();
        cbImmuneP.Text = "我方总部免疫伤害"; cbImmuneP.Location = new Point(140, 478); cbImmuneP.Size = new Size(150, 22);
        cbImmuneP.ForeColor = form.ForeColor;
        cbImmuneP.CheckedChanged += delegate { try { if (cbImmuneP.Checked) cbImmuneA.Checked = false; PushFlags(); } catch { } };
        form.Controls.Add(cbImmuneP);
        cbImmuneA = new CheckBox();
        cbImmuneA.Text = "敌方总部免疫伤害"; cbImmuneA.Location = new Point(296, 478); cbImmuneA.Size = new Size(150, 22);
        cbImmuneA.ForeColor = form.ForeColor;
        cbImmuneA.CheckedChanged += delegate { try { if (cbImmuneA.Checked) cbImmuneP.Checked = false; PushFlags(); } catch { } };
        form.Controls.Add(cbImmuneA);

        btnSkip = NewBtn("跳过 AI 下个回合", 12, 508, 150, 30);
        btnHeal = NewBtn("双方总部回满", 170, 508, 130, 30);
        btnWin = NewBtn("直接获胜", 308, 508, 110, 30);
        btnWin.BackColor = Color.FromArgb(60, 30, 30);
        btnSkip.Click += delegate { NewCmd("skipAi", null); };
        btnHeal.Click += delegate { NewCmd("heal", null); };
        btnWin.Click += delegate
        {
            if (MessageBox.Show("直接判玩家获胜？（Boss 剩余命数一并跳过）", "确认", MessageBoxButtons.YesNo, MessageBoxIcon.Question) == DialogResult.Yes)
                NewCmd("win", null);
        };

        NewLabel("日志", 12, 546, 100, 18);
        txtLog = new TextBox();
        txtLog.Location = new Point(12, 566); txtLog.Size = new Size(600, 170);
        txtLog.Multiline = true; txtLog.ScrollBars = ScrollBars.Vertical; txtLog.ReadOnly = true;
        txtLog.BackColor = Color.FromArgb(12, 16, 22); txtLog.ForeColor = Color.FromArgb(185, 196, 207);
        txtLog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
        try { txtLog.Font = new Font("Consolas", 9f); } catch { }
        form.Controls.Add(txtLog);
    }

    static void SendCard(string cmd)
    {
        int i = list.SelectedIndex;
        if (i < 0 || i >= shown.Count) return;
        Dictionary<string, object> a = new Dictionary<string, object>();
        a["id"] = Str(shown[i], "id");
        a["group"] = Str(shown[i], "group");
        NewCmd(cmd, a);
    }
    static void PushFlags()
    {
        Dictionary<string, object> a = new Dictionary<string, object>();
        a["infiniteKredit"] = cbKredit.Checked;
        a["hqImmuneSide"] = cbImmuneP.Checked ? "p" : (cbImmuneA.Checked ? "a" : null);
        NewCmd("flags", a);
    }
    static string Str(Dictionary<string, object> d, string k)
    {
        object v;
        return (d != null && d.TryGetValue(k, out v) && v != null) ? Convert.ToString(v) : "";
    }
    static int Int(Dictionary<string, object> d, string k)
    {
        object v; int n = 0;
        if (d != null && d.TryGetValue(k, out v) && v != null) int.TryParse(Convert.ToString(v), out n);
        return n;
    }
    static void UpdateButtons()
    {
        int i = list.SelectedIndex;
        bool ok = i >= 0 && i < shown.Count;
        btnHand.Enabled = ok; btnDeck.Enabled = ok;
        btnBoard.Enabled = ok && Str(shown[i], "kind") == "unit";
    }

    static void FillList()
    {
        string q = (txtSearch.Text ?? "").Trim().ToLower();
        string grp = "all";
        switch (cmbGroup.SelectedIndex) { case 1: grp = "normal"; break; case 2: grp = "derived"; break; case 3: grp = "jm"; break; case 4: grp = "veteran"; break; }
        List<Dictionary<string, object>> src;
        lock (gate) { src = cards; }
        List<Dictionary<string, object>> next = new List<Dictionary<string, object>>();
        foreach (Dictionary<string, object> c in src)
        {
            if (grp != "all" && Str(c, "group") != grp) continue;
            if (q.Length > 0)
            {
                string n = Str(c, "n").ToLower(), id = Str(c, "id").ToLower();
                if (n.IndexOf(q) < 0 && id.IndexOf(q) < 0) continue;
            }
            next.Add(c);
            if (next.Count >= 300) break;
        }
        shown = next;
        list.BeginUpdate();
        try
        {
            list.Items.Clear();
            foreach (Dictionary<string, object> c in shown)
            {
                string kind = Str(c, "kind") == "unit" ? "单位" : (Str(c, "kind") == "counter" ? "反制" : "指令");
                string tag = "正常";
                if (Str(c, "group") == "derived") tag = "衍生";
                else if (Str(c, "group") == "jm") tag = "JM";
                else if (Str(c, "group") == "veteran") tag = "老兵";
                string extra = "";
                object av, hv;
                if (Str(c, "kind") == "unit" && c.TryGetValue("a", out av) && av != null)
                {
                    c.TryGetValue("h", out hv);
                    extra = " " + Convert.ToString(av) + "/" + Convert.ToString(hv);
                }
                list.Items.Add(Str(c, "n") + "  [" + tag + "·" + kind + "·" + Int(c, "cost") + "费" + extra + "]");
            }
        }
        finally { list.EndUpdate(); }
        lblCards.Text = "卡牌（共 " + src.Count + " 张，显示 " + shown.Count + "）";
        try { UpdateButtons(); } catch { }
    }

    static string Val(Dictionary<string, object> d, string k)
    {
        object v;
        if (d == null || !d.TryGetValue(k, out v) || v == null) return "—";
        return Convert.ToString(v);
    }
    static void UpdateStateLabels()
    {
        bool online = (DateTime.Now - lastPoll).TotalSeconds < 3;
        string st = "游戏：" + (online ? "● 在线" : "○ 离线（等 KADMIN 打开）") + "　端口 " + PORT;
        // 只在内容变化时写 Text：WinForms 每次赋值都会重画
        if (st != lastStatusText)
        {
            lastStatusText = st;
            lblStatus.Text = st;
            lblStatus.ForeColor = online ? Color.FromArgb(120, 240, 150) : Color.FromArgb(255, 130, 120);
        }
        string json;
        int ver;
        lock (gate) { json = stateJson; ver = stateVer; }
        if (ver == uiStateVer || json.Length == 0) return;
        uiStateVer = ver;
        try
        {
            Dictionary<string, object> state = JSON.DeserializeObject(json) as Dictionary<string, object>;
            if (state == null) return;
            Dictionary<string, object> p = state.ContainsKey("p") ? state["p"] as Dictionary<string, object> : null;
            Dictionary<string, object> a = state.ContainsKey("a") ? state["a"] as Dictionary<string, object> : null;
            if (p == null || a == null) return;
            string boss = "";
            if (state.ContainsKey("bossKind") && state["bossKind"] != null)
                boss = "（" + Convert.ToString(state["bossKind"]) + " 第" + Val(state, "bossLife") + "条命）";
            bool over = state.ContainsKey("over") && state["over"] != null && Convert.ToBoolean(state["over"]);
            string s2 = "回合 " + Val(state, "turn") + " · " + Val(state, "phase") + (over ? " · 已结束" : "")
                + "　我方 " + Val(p, "hp") + "/" + Val(p, "maxHp")
                + "　敌方 " + Val(a, "hp") + "/" + Val(a, "maxHp") + boss
                + "　指挥点 " + Val(p, "kredit") + "/" + Val(p, "slots");
            if (s2 != lastStateText) { lastStateText = s2; lblState.Text = s2; }
        }
        catch { }
    }

    /* ---------------- UI 心跳：取队列 + 按需重建（不做网络 IO） ---------------- */
    static void UiTick()
    {
        DrainLog();
        int ver;
        lock (gate) { ver = cardsVer; }
        if (ver != uiCardsVer) { uiCardsVer = ver; if (cards.Count > 0) FillList(); }
        UpdateStateLabels();
    }

    /* ---------------- 最小 HTTP 服务（后台线程） ---------------- */
    static void ServerLoop()
    {
        while (!serverStop)
        {
            try
            {
                if (listener == null || !listener.Pending()) { Thread.Sleep(15); continue; }
                TcpClient client = listener.AcceptTcpClient();
                try { Handle(client); }
                catch (Exception e) { ReportCrash(e, "请求处理"); try { client.Close(); } catch { } }
            }
            catch (Exception e)
            {
                if (!serverStop) { ReportCrash(e, "服务循环"); Thread.Sleep(200); }
            }
        }
    }

    static void Handle(TcpClient client)
    {
        NetworkStream s = client.GetStream();
        s.ReadTimeout = 2000;
        MemoryStream ms = new MemoryStream();
        byte[] buf = new byte[65536];
        string head = "";
        string body = "";
        DateTime deadline = DateTime.Now.AddMilliseconds(2000);
        while (DateTime.Now < deadline)
        {
            if (s.DataAvailable)
            {
                int n = s.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                ms.Write(buf, 0, n);
                byte[] all = ms.ToArray();
                string txt = Encoding.UTF8.GetString(all);
                int he = txt.IndexOf("\r\n\r\n");
                if (he >= 0)
                {
                    head = txt.Substring(0, he);
                    int contentLen = 0;
                    foreach (string line in head.Split(new string[] { "\r\n" }, StringSplitOptions.None))
                    {
                        string low = line.ToLower();
                        if (low.StartsWith("content-length:")) int.TryParse(line.Substring(15).Trim(), out contentLen);
                    }
                    if (all.Length - (he + 4) >= contentLen)
                    {
                        body = Encoding.UTF8.GetString(all, he + 4, all.Length - (he + 4));
                        break;
                    }
                }
            }
            else Thread.Sleep(3);
        }
        string path = "/";
        string query = "";
        if (head.Length > 0)
        {
            string[] parts = head.Split(new string[] { "\r\n" }, StringSplitOptions.None)[0].Split(' ');
            if (parts.Length >= 2)
            {
                path = parts[1];
                int qi = path.IndexOf('?');
                if (qi >= 0) { query = path.Substring(qi + 1); path = path.Substring(0, qi); }
            }
        }

        if (path == "/poll")
        {
            lastPoll = DateTime.Now;
            int since = 0;
            foreach (string kv in query.Split('&'))
            {
                string[] p2 = kv.Split(new char[] { '=' }, 2);
                if (p2.Length == 2 && p2[0] == "since") int.TryParse(p2[1], out since);
            }
            List<object> outCmds = new List<object>();
            lock (gate)
            {
                // UI 排队的新命令在这里正式发号，保证「发号顺序 = 游戏看到的顺序」
                Dictionary<string, object> c;
                while (cmdQueue.TryDequeue(out c))
                {
                    c["id"] = nextId++;
                    cmds.Add(c);
                }
                foreach (Dictionary<string, object> cc in cmds) if (Convert.ToInt32(cc["id"]) > since) outCmds.Add(cc);
            }
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["commands"] = outCmds;
            bool need;
            lock (gate) { need = cards.Count == 0; }
            payload["needIndex"] = need;
            payload["port"] = PORT;
            Respond(s, JSON.Serialize(payload));
        }
        else if (path == "/index")
        {
            try
            {
                Dictionary<string, object> j = JSON.DeserializeObject(body) as Dictionary<string, object>;
                if (j != null && j.ContainsKey("cards"))
                {
                    List<Dictionary<string, object>> next = new List<Dictionary<string, object>>();
                    object[] arr = j["cards"] as object[];
                    if (arr != null) foreach (object o in arr) { Dictionary<string, object> d = o as Dictionary<string, object>; if (d != null) next.Add(d); }
                    lock (gate) { cards = next; cardsVer++; }
                    AddLog("← 收到卡牌索引 " + next.Count + " 张");
                }
            }
            catch (Exception e) { AddLog("索引解析失败：" + e.Message); }
            Respond(s, "{\"ok\":true}");
        }
        else if (path == "/state")
        {
            if (body.Length > 0) { lock (gate) { stateJson = body; stateVer++; } }
            Respond(s, "{\"ok\":true}");
        }
        else if (path == "/ack")
        {
            try
            {
                Dictionary<string, object> j = JSON.DeserializeObject(body) as Dictionary<string, object>;
                bool ok = j != null && j.ContainsKey("ok") && Convert.ToBoolean(j["ok"]);
                string msg = (j != null && j.ContainsKey("msg")) ? Convert.ToString(j["msg"]) : "";
                AddLog((ok ? "✔ " : "✖ ") + msg);
            }
            catch { }
            Respond(s, "{\"ok\":true}");
        }
        else Respond(s, "{\"ok\":false,\"msg\":\"unknown path\"}");

        try { s.Close(); } catch { }
        try { client.Close(); } catch { }
    }
    static int nextId = 1;

    static void Respond(NetworkStream s, string body)
    {
        byte[] bb = Encoding.UTF8.GetBytes(body);
        string head = "HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\n"
            + "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nCache-Control: no-store\r\n"
            + "Content-Length: " + bb.Length + "\r\nConnection: close\r\n\r\n";
        byte[] hb = Encoding.ASCII.GetBytes(head);
        s.Write(hb, 0, hb.Length);
        s.Write(bb, 0, bb.Length);
        s.Flush();
    }

    /* ---------------- 自检模式（-selftest）：自动排队几条命令，供回归脚本验证整条链路 ---------------- */
    static int stTick = 0, stQ = 0;
    static void StartSelfTest()
    {
        try { if (File.Exists(logFile)) File.Delete(logFile); } catch { }
        AddLog("[自检] 启动，等待游戏连上来…");
        System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
        t.Interval = 1000;
        t.Tick += delegate
        {
            stTick++;
            bool online = (DateTime.Now - lastPoll).TotalSeconds < 3;
            bool inGame = false;
            try
            {
                string json; lock (gate) { json = stateJson; }
                if (json.Length > 0)
                {
                    Dictionary<string, object> st = JSON.DeserializeObject(json) as Dictionary<string, object>;
                    inGame = st != null && st.ContainsKey("turn") && Convert.ToInt32(st["turn"]) >= 1;
                }
            }
            catch { }
            if (online && inGame)
            {
                if (stQ == 0) AddLog("[自检] 游戏已开局，开始发命令");
                stQ++;
                Dictionary<string, object> a;
                switch (stQ)
                {
                    case 1:
                        AddLog("[自检] 队列：无限指挥点");
                        a = new Dictionary<string, object>(); a["infiniteKredit"] = true; NewCmd("flags", a); break;
                    case 3:
                        AddLog("[自检] 队列：SUPERMAN 入手");
                        a = new Dictionary<string, object>(); a["id"] = "SUPERMAN"; a["group"] = "jm"; NewCmd("addHand", a); break;
                    case 5:
                        AddLog("[自检] 队列：SUPERMAN 上场");
                        a = new Dictionary<string, object>(); a["id"] = "SUPERMAN"; a["group"] = "jm"; NewCmd("addBoard", a); break;
                    case 7:
                        AddLog("[自检] 队列：轻步兵置顶");
                        a = new Dictionary<string, object>(); a["id"] = "lightinf"; a["group"] = "derived"; NewCmd("addDeck", a); break;
                    case 9:
                        AddLog("[自检] 队列：跳过 AI 回合"); NewCmd("skipAi", null); break;
                    case 11:
                        AddLog("[自检] 队列：直接获胜"); NewCmd("win", null); break;
                }
                if (stQ >= 15) { t.Stop(); AddLog("[自检] 结束"); form.Close(); }
            }
            else if (stTick >= 70) { t.Stop(); AddLog("[自检] 游戏一直没开局，结束"); form.Close(); }
        };
        t.Start();
    }
}

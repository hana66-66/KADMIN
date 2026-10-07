# ============================================================
#  KADMIN 开发者面板（本地窗口版）
#  - 原生 WinForms 小窗口（不是浏览器页面）
#  - 内置一个最小 HTTP 服务（127.0.0.1:7788），游戏里自带的开发者桥会来轮询/回传
#  - 功能：指定卡（含 JM / 衍生卡 / 老兵形态）加入手牌 / 加入战场 / 置于卡组顶
#          无限指挥点、总部免疫伤害、跳过 AI 下个回合、双方总部回满、直接获胜
#  用法：双击「启动开发者面板.cmd」，或 powershell -ExecutionPolicy Bypass -File 本文件
# ============================================================
param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:SelfTest  = [bool]$SelfTest
$script:logFile   = Join-Path $env:TEMP 'kadmin-dev-panel.log'
$script:PORT      = 7788
$script:cmds      = New-Object System.Collections.ArrayList   # 待游戏领取的命令
$script:nextId    = 1
$script:cards     = @()
$script:shown     = @()
$script:listener  = $null
$script:lastPoll  = [datetime]::MinValue
$script:state     = $null
$script:logLines  = New-Object System.Collections.ArrayList

function Add-Log([string]$msg){
  $line = ('[{0}] {1}' -f (Get-Date).ToString('HH:mm:ss'), $msg)
  [void]$script:logLines.Insert(0, $line)
  if($script:logLines.Count -gt 300){ $script:logLines.RemoveAt($script:logLines.Count - 1) }
  if($script:txtLog){ $script:txtLog.Text = ($script:logLines -join "`r`n") }
  if($script:SelfTest){ try{ Add-Content -Path $script:logFile -Value $line -Encoding UTF8 }catch{} }
}
function New-Cmd([string]$cmd, $cmdArgs){
  # 注意：参数名不要用 $args —— 那是 PowerShell 自动变量，会拿不到传进来的值（踩过）
  $c = [ordered]@{ id = $script:nextId; cmd = $cmd; args = $cmdArgs }
  $script:nextId++
  [void]$script:cmds.Add($c)
  $shown = if($cmdArgs){ ' ' + ($cmdArgs | ConvertTo-Json -Compress) } else { '' }
  Add-Log ('→ ' + $cmd + $shown)
  return $c
}

# ---------------- 最小 HTTP 服务（TcpListener，无需管理员） ----------------
function Start-DevServer{
  $script:listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $script:PORT)
  $script:listener.Start()
}
function Send-Response($stream, [string]$body){
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $head = "HTTP/1.1 200 OK`r`nContent-Type: application/json; charset=utf-8`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Headers: *`r`nCache-Control: no-store`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}
function Read-Request($stream){
  # 读请求行 + 头（本地小请求，一次读完即可）
  $buf = New-Object byte[] 8192
  $sb = New-Object System.Text.StringBuilder
  $len = 0
  $deadline = (Get-Date).AddMilliseconds(700)
  while((Get-Date) -lt $deadline){
    if($stream.DataAvailable){
      $n = $stream.Read($buf, 0, $buf.Length)
      if($n -le 0){ break }
      [void]$sb.Append([System.Text.Encoding]::UTF8.GetString($buf, 0, $n))
      $txt = $sb.ToString()
      if($txt.Contains("`r`n`r`n")){
        $head = $txt.Substring(0, $txt.IndexOf("`r`n`r`n"))
        $cl = 0
        foreach($line in ($head -split "`r`n")){
          if($line -match '^(?i)Content-Length:\s*(\d+)'){ $cl = [int]$Matches[1] }
        }
        $bodyStart = $txt.IndexOf("`r`n`r`n") + 4
        if(($txt.Length - $bodyStart) -ge $cl -and $cl -ge 0){
          return @{ head = $head; body = $txt.Substring($bodyStart, ($txt.Length - $bodyStart)) }
        }
      }
    } else {
      Start-Sleep -Milliseconds 8
    }
  }
  $txt = $sb.ToString()
  $idx = $txt.IndexOf("`r`n`r`n")
  if($idx -ge 0){ return @{ head = $txt.Substring(0, $idx); body = $txt.Substring($idx + 4) } }
  return @{ head = $txt; body = '' }
}
function Handle-Request($client){
  $stream = $client.GetStream()
  $stream.ReadTimeout = 700
  $req = Read-Request $stream
  $line = ($req.head -split "`r`n")[0]
  $parts = $line -split ' '
  $method = if($parts.Count -ge 1){ $parts[0] } else { 'GET' }
  $path = if($parts.Count -ge 2){ $parts[1] } else { '/' }
  $query = @{}
  $qIdx = $path.IndexOf('?')
  if($qIdx -ge 0){
    $qs = $path.Substring($qIdx + 1); $path = $path.Substring(0, $qIdx)
    foreach($kv in ($qs -split '&')){
      $p = $kv -split '=', 2
      if($p.Count -eq 2){ $query[$p[0]] = [System.Uri]::UnescapeDataString($p[1]) }
    }
  }
  if($path -eq '/poll'){
    $script:lastPoll = Get-Date
    $since = 0
    if($query.ContainsKey('since')){ [void][int]::TryParse($query['since'], [ref]$since) }
    $out = @()
    foreach($c in $script:cmds){ if([int]$c.id -gt $since){ $out += $c } }
    $needIndex = ($script:cards.Count -eq 0)
    $payload = @{ commands = $out; needIndex = $needIndex; cards = $script:cards.Count; port = $script:PORT } | ConvertTo-Json -Depth 6 -Compress
    Send-Response $stream $payload
  } elseif($path -eq '/index'){
    try{ $j = $req.body | ConvertFrom-Json; $script:cards = @($j.cards); Fill-List; Add-Log ('← 收到卡牌索引 ' + $script:cards.Count + ' 张') }catch{ Add-Log ('索引解析失败：' + $_.Exception.Message) }
    Send-Response $stream '{"ok":true}'
  } elseif($path -eq '/state'){
    try{ $script:state = $req.body | ConvertFrom-Json; Update-StateLabels }catch{}
    Send-Response $stream '{"ok":true}'
  } elseif($path -eq '/ack'){
    try{
      $j = $req.body | ConvertFrom-Json
      Add-Log (($(if($j.ok){ '✔ ' } else { '✖ ' })) + $j.msg)
    }catch{}
    Send-Response $stream '{"ok":true}'
  } else {
    Send-Response $stream '{"ok":false,"msg":"unknown path"}'
  }
  $stream.Close(); $client.Close()
}
function Pump-Server{
  try{
    $guard = 0
    while($script:listener -and $script:listener.Pending() -and $guard -lt 12){
      $guard++
      $client = $script:listener.AcceptTcpClient()
      try{ Handle-Request $client }catch{ try{ $client.Close() }catch{} }
    }
  }catch{}
}

# ---------------- 界面 ----------------
$form = New-Object System.Windows.Forms.Form
$form.Text = 'KADMIN 开发者面板'
$form.Size = New-Object System.Drawing.Size(620, 780)
$form.MinimumSize = New-Object System.Drawing.Size(430, 520)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(60, 60)
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 22, 28)
$form.ForeColor = [System.Drawing.Color]::FromArgb(230, 237, 243)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

function New-Label($text, $x, $y, $w, $h){
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text; $l.Location = New-Object System.Drawing.Point($x, $y); $l.Size = New-Object System.Drawing.Size($w, $h)
  $l.ForeColor = [System.Drawing.Color]::FromArgb(200, 210, 220)
  $form.Controls.Add($l); return $l
}
function New-Btn($text, $x, $y, $w, $h){
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, $h)
  $b.FlatStyle = 'Flat'; $b.BackColor = [System.Drawing.Color]::FromArgb(35, 43, 53)
  $b.ForeColor = [System.Drawing.Color]::FromArgb(230, 237, 243)
  $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(70, 84, 100)
  $form.Controls.Add($b); return $b
}

$lblStatus = New-Label '游戏：○ 离线（等 KADMIN 打开）' 12 8 580 20
$lblState  = New-Label '回合 —　我方 —　敌方 —　指挥点 —' 12 30 580 20

$lblCards = New-Label '卡牌（连接后自动拉取：正常卡池 / 衍生卡 / JM / 老兵形态）' 12 58 580 18
$txtSearch = New-Object System.Windows.Forms.TextBox
$txtSearch.Location = New-Object System.Drawing.Point(12, 80); $txtSearch.Size = New-Object System.Drawing.Size(430, 24)
$txtSearch.BackColor = [System.Drawing.Color]::FromArgb(12, 16, 22); $txtSearch.ForeColor = $form.ForeColor
$txtSearch.BorderStyle = 'FixedSingle'
$form.Controls.Add($txtSearch)
$cmbGroup = New-Object System.Windows.Forms.ComboBox
$cmbGroup.Location = New-Object System.Drawing.Point(452, 80); $cmbGroup.Size = New-Object System.Drawing.Size(140, 24)
$cmbGroup.DropDownStyle = 'DropDownList'
[void]$cmbGroup.Items.AddRange(@('全部', '正常卡池', '衍生卡', 'JM', '老兵形态'))
$cmbGroup.SelectedIndex = 0
$cmbGroup.BackColor = [System.Drawing.Color]::FromArgb(12, 16, 22); $cmbGroup.ForeColor = $form.ForeColor
$form.Controls.Add($cmbGroup)

$list = New-Object System.Windows.Forms.ListBox
$list.Location = New-Object System.Drawing.Point(12, 110); $list.Size = New-Object System.Drawing.Size(580, 300)
$list.BackColor = [System.Drawing.Color]::FromArgb(12, 16, 22); $list.ForeColor = $form.ForeColor
$list.BorderStyle = 'FixedSingle'; $list.IntegralHeight = $false
$list.Anchor = 'Top,Left,Right'
$form.Controls.Add($list)

$btnHand  = New-Btn '加入手牌' 12 418 130 30
$btnBoard = New-Btn '加入战场' 150 418 130 30
$btnDeck  = New-Btn '置于卡组顶' 288 418 130 30
$btnClear = New-Btn '清空搜索' 426 418 90 30
$btnHand.Enabled = $false; $btnBoard.Enabled = $false; $btnDeck.Enabled = $false

$lblFlags = New-Label '作弊开关' 12 456 200 18
$cbKredit = New-Object System.Windows.Forms.CheckBox
$cbKredit.Text = '无限指挥点'; $cbKredit.Location = New-Object System.Drawing.Point(12, 476); $cbKredit.Size = New-Object System.Drawing.Size(120, 22)
$cbKredit.ForeColor = $form.ForeColor; $form.Controls.Add($cbKredit)
$cbImmuneP = New-Object System.Windows.Forms.CheckBox
$cbImmuneP.Text = '我方总部免疫伤害'; $cbImmuneP.Location = New-Object System.Drawing.Point(140, 476); $cbImmuneP.Size = New-Object System.Drawing.Size(150, 22)
$cbImmuneP.ForeColor = $form.ForeColor; $form.Controls.Add($cbImmuneP)
$cbImmuneA = New-Object System.Windows.Forms.CheckBox
$cbImmuneA.Text = '敌方总部免疫伤害'; $cbImmuneA.Location = New-Object System.Drawing.Point(296, 476); $cbImmuneA.Size = New-Object System.Drawing.Size(150, 22)
$cbImmuneA.ForeColor = $form.ForeColor; $form.Controls.Add($cbImmuneA)

$btnSkip = New-Btn '跳过 AI 下个回合' 12 506 150 30
$btnHeal = New-Btn '双方总部回满' 170 506 130 30
$btnWin  = New-Btn '直接获胜' 308 506 110 30
$btnWin.BackColor = [System.Drawing.Color]::FromArgb(60, 30, 30)

$lblLog = New-Label '日志' 12 544 100 18
$txtLog = New-Object System.Windows.Forms.TextBox
$txtLog.Location = New-Object System.Drawing.Point(12, 564); $txtLog.Size = New-Object System.Drawing.Size(580, 160)
$txtLog.Multiline = $true; $txtLog.ScrollBars = 'Vertical'; $txtLog.ReadOnly = $true
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(12, 16, 22); $txtLog.ForeColor = [System.Drawing.Color]::FromArgb(185, 196, 207)
$txtLog.Anchor = 'Top,Left,Right,Bottom'; $txtLog.Font = New-Object System.Drawing.Font('Consolas', 9)
$form.Controls.Add($txtLog)
$script:txtLog = $txtLog

# ---------------- 卡牌列表 ----------------
function Fill-List{
  $q = $txtSearch.Text.Trim().ToLower()
  $grp = @('all','normal','derived','jm','veteran')[$cmbGroup.SelectedIndex]
  $map = @{ 'normal'='normal'; '衍生卡'='derived'; 'JM'='jm'; '老兵形态'='veteran' }
  if($cmbGroup.SelectedIndex -gt 0){ $grp = $map[$cmbGroup.SelectedItem] }
  $script:shown = @()
  foreach($c in $script:cards){
    if($grp -ne 'all' -and $c.group -ne $grp){ continue }
    if($q -ne '' -and -not (($c.n -as [string]).ToLower().Contains($q)) -and -not (($c.id -as [string]).ToLower().Contains($q))){ continue }
    $script:shown += $c
    if($script:shown.Count -ge 400){ break }
  }
  $list.BeginUpdate()
  $list.Items.Clear()
  foreach($c in $script:shown){
    $kind = if($c.kind -eq 'unit'){ '单位' } elseif($c.kind -eq 'counter'){ '反制' } else { '指令' }
    $tag = switch($c.group){ 'derived' { '衍生' } 'jm' { 'JM' } 'veteran' { '老兵' } default { '正常' } }
    $extra = if($c.kind -eq 'unit' -and $c.a -ne $null){ ' ' + $c.a + '/' + $c.h } else { '' }
    [void]$list.Items.Add(('{0}  [{1}·{2}·{3}费{4}]' -f $c.n, $tag, $kind, $c.cost, $extra))
  }
  $list.EndUpdate()
  $lblCards.Text = ('卡牌（共 ' + $script:cards.Count + ' 张，显示 ' + $script:shown.Count + '）')
}
function Update-StateLabels{
  $st = $script:state
  if(-not $st){ return }
  $online = ((Get-Date) - $script:lastPoll).TotalSeconds -lt 3
  $lblStatus.Text = '游戏：' + ($(if($online){ '● 在线' } else { '○ 离线（等 KADMIN 打开）' })) + '　端口 ' + $script:PORT
  $lblStatus.ForeColor = if($online){ [System.Drawing.Color]::FromArgb(120, 240, 150) } else { [System.Drawing.Color]::FromArgb(255, 130, 120) }
  $boss = if($st.bossKind){ '（' + $st.bossKind + ' 第' + $st.bossLife + '条命）' } else { '' }
  $lblState.Text = ('回合 {0} · {1}{2}　我方 {3}/{4}　敌方 {5}/{6}{7}　指挥点 {8}/{9}' -f $st.turn, $st.phase, $(if($st.over){ ' · 已结束' } else { '' }), $st.p.hp, $st.p.maxHp, $st.a.hp, $st.a.maxHp, $boss, $st.p.kredit, $st.p.slots)
}

# ---------------- 事件 ----------------
$txtSearch.add_TextChanged({ Fill-List })
$cmbGroup.add_SelectedIndexChanged({ Fill-List })
$list.add_SelectedIndexChanged({
  $ok = $list.SelectedIndex -ge 0
  $btnHand.Enabled = $ok; $btnDeck.Enabled = $ok
  $btnBoard.Enabled = ($ok -and $script:shown[$list.SelectedIndex].kind -eq 'unit')
})
$btnClear.add_Click({ $txtSearch.Text = ''; Fill-List })
$btnHand.add_Click({  if($list.SelectedIndex -ge 0){ $c = $script:shown[$list.SelectedIndex]; [void](New-Cmd 'addHand'  @{ id = $c.id; group = $c.group }) } })
$btnBoard.add_Click({ if($list.SelectedIndex -ge 0){ $c = $script:shown[$list.SelectedIndex]; [void](New-Cmd 'addBoard' @{ id = $c.id; group = $c.group }) } })
$btnDeck.add_Click({  if($list.SelectedIndex -ge 0){ $c = $script:shown[$list.SelectedIndex]; [void](New-Cmd 'addDeck'  @{ id = $c.id; group = $c.group }) } })
function Push-Flags{
  $side = if($cbImmuneP.Checked){ 'p' } elseif($cbImmuneA.Checked){ 'a' } else { $null }
  [void](New-Cmd 'flags' @{ infiniteKredit = [bool]$cbKredit.Checked; hqImmuneSide = $side })
}
$cbKredit.add_CheckedChanged({ Push-Flags })
$cbImmuneP.add_CheckedChanged({ if($cbImmuneP.Checked -and $cbImmuneA.Checked){ $cbImmuneA.Checked = $false }; Push-Flags })
$cbImmuneA.add_CheckedChanged({ if($cbImmuneA.Checked -and $cbImmuneP.Checked){ $cbImmuneP.Checked = $false }; Push-Flags })
$btnSkip.add_Click({ [void](New-Cmd 'skipAi' $null) })
$btnHeal.add_Click({ [void](New-Cmd 'heal' $null) })
$btnWin.add_Click({
  if([System.Windows.Forms.MessageBox]::Show('直接判玩家获胜？（Boss 剩余命数一并跳过）','确认','YesNo','Question') -eq 'Yes'){
    [void](New-Cmd 'win' $null)
  }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 40
$timer.add_Tick({ Pump-Server; Update-StateLabels })
$timer.Start()

$form.add_FormClosing({
  try{ if($script:listener){ $script:listener.Stop() } }catch{}
})

# ---------------- 启动 ----------------
try{
  Start-DevServer
  Add-Log ('开发者面板已启动：http://127.0.0.1:' + $script:PORT)
  Add-Log '请在浏览器里打开 KADMIN-卡兹铭刻.html；连上后这里会自动收到卡牌索引。'
}catch{
  [void][System.Windows.Forms.MessageBox]::Show('端口 ' + $script:PORT + ' 启动失败：' + $_.Exception.Message + "`r`n`r`n可能是面板已经开着一个，或端口被占用。", 'KADMIN 开发者面板')
}

# ---------------- 自检模式（-SelfTest）：自动排队几条命令，供回归脚本验证整条链路 ----------------
if($script:SelfTest){
  try{ Remove-Item $script:logFile -ErrorAction SilentlyContinue }catch{}
  Add-Log '[自检] 启动，等待游戏来轮询…'
  $script:t = 0
  $script:q = 0
  $st = New-Object System.Windows.Forms.Timer
  $st.Interval = 1000
  $st.add_Tick({
    $script:t++
    $online = ((Get-Date) - $script:lastPoll).TotalSeconds -lt 3     # 游戏来轮询过才发命令，避免测试抢跑
    if($online){
      if($script:q -eq 0){ Add-Log '[自检] 游戏已连上，开始发命令' }
      $script:q++
      switch($script:q){
        1 { Add-Log '[自检] 队列：无限指挥点';    [void](New-Cmd 'flags'   @{ infiniteKredit = $true }) }
        3 { Add-Log '[自检] 队列：SUPERMAN 入手'; [void](New-Cmd 'addHand' @{ id = 'SUPERMAN'; group = 'jm' }) }
        5 { Add-Log '[自检] 队列：SUPERMAN 上场'; [void](New-Cmd 'addBoard' @{ id = 'SUPERMAN'; group = 'jm' }) }
        7 { Add-Log '[自检] 队列：轻步兵置顶';    [void](New-Cmd 'addDeck' @{ id = 'lightinf'; group = 'derived' }) }
        9 { Add-Log '[自检] 队列：跳过 AI 回合';  [void](New-Cmd 'skipAi' $null) }
        11{ Add-Log '[自检] 队列：直接获胜';      [void](New-Cmd 'win' $null) }
      }
      if($script:q -ge 15){ $st.Stop(); Add-Log '[自检] 结束'; $form.Close() }
    } elseif($script:t -ge 70){
      $st.Stop(); Add-Log '[自检] 游戏一直没连上，结束'; $form.Close()
    }
  })
  $st.Start()
}

[void]$form.Show()
[System.Windows.Forms.Application]::Run($form)
try{ if($script:listener){ $script:listener.Stop() } }catch{}

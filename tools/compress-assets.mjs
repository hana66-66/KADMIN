// compress-assets.mjs —— 素材压缩（卡牌 + 盟国卡背）
// 规则（对齐既有管线约定）：宽度 > 430 的图 → 缩到 430 宽；含透明通道先压平到卡面底色 #14100c；
//   统一按 JPEG q82 编码（沿用「.png 文件名装 JPEG 字节」的既有做法，build.mjs 会按内容嗅探 MIME）。
// 原图备份到 素材备份_压缩前/<相对路径>（已存在则不覆盖，可随时回滚）。
// 用法：node tools/compress-assets.mjs [--dry]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const dry = process.argv.includes('--dry');

const ps = `
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = $env:DSH_ROOT
$dry = $env:DSH_DRY -eq '1'
$limit = [int]$env:DSH_LIMIT
$backup = Join-Path $root '素材备份_压缩前'
$targets = @('卡牌', '装饰\\卡背\\盟国')
$maxW = 430
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$bg = [System.Drawing.Color]::FromArgb(255, 20, 16, 12)   # #14100c：UI 卡面底色，透明圆角压平后与界面一致
$done = 0; $skip = 0; $before = 0; $after = 0
foreach($t in $targets){
  $dir = Join-Path $root $t
  if(-not (Test-Path $dir)){ continue }
  Get-ChildItem $dir -Recurse -File | Where-Object { $_.Extension -in @('.png','.jpg','.jpeg') } | ForEach-Object {
    $f = $_
    if($limit -gt 0 -and $done -ge $limit){ return }
    $img = $null
    try {
      $img = [System.Drawing.Image]::FromFile($f.FullName)
      if($img.Width -le $maxW){ $skip++; return }
      $rel = $f.FullName.Substring($root.Length + 1)
      Write-Output ("处理 [" + ($done+1) + "] " + $rel + " (" + [int]($f.Length/1KB) + "KB)")
      [Console]::Out.Flush()
      $w = $maxW; $h = [int][Math]::Round($img.Height * $maxW / $img.Width)
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = 'HighQualityBicubic'
      $g.PixelOffsetMode = 'HighQuality'
      $g.Clear($bg)
      $g.DrawImage($img, 0, 0, $w, $h)
      $g.Dispose()
      $img.Dispose(); $img = $null
      if($dry){ $before += $f.Length; $after += [int]($w*$h/6); $done++; $bmp.Dispose(); return }
      $tmp = $f.FullName + '.c.jpg'
      $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
      $bmp.Save($tmp, $codec, $ep)
      $bmp.Dispose()
      $before += $f.Length; $after += (Get-Item $tmp).Length
      $bak = Join-Path $backup $rel
      if(-not (Test-Path $bak)){
        $bd = Split-Path $bak -Parent
        if(-not (Test-Path $bd)){ New-Item -ItemType Directory -Force -Path $bd | Out-Null }
        Copy-Item $f.FullName $bak -Force
      }
      Move-Item -Force $tmp $f.FullName
      $done++
    } finally { if($img){ $img.Dispose() } }
  }
}
$tag = if($dry){ '预估' } else { '压缩完成' }
Write-Output ("{0}: 处理 {1} 张 | 跳过(已<=430px) {2} 张 | {3:N1} MB -> {4:N1} MB (省 {5:N1} MB)" -f $tag, $done, $skip, ($before/1MB), ($after/1MB), (($before-$after)/1MB))
`;
const enc = Buffer.from(ps, 'utf16le').toString('base64');
const out = execFileSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
  { env: { ...process.env, DSH_ROOT: root, DSH_DRY: dry ? '1' : '0', DSH_LIMIT: String(process.env.DSH_LIMIT || '0') }, encoding: 'utf8' });
process.stdout.write(out);

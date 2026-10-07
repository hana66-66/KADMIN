// 总部与卡背压缩：透明通道平铺到深色底（与牌桌/桌面融色）后转高质 JPEG；已压缩的跳过
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const ps = `
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = $env:DSH_ROOT
$backup = Join-Path $root '素材备份_压缩前'
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
function Is-Jpeg($p){ $fs=[System.IO.File]::OpenRead($p); try { return ($fs.ReadByte() -eq 255 -and $fs.ReadByte() -eq 216) } finally { $fs.Dispose() } }
$roots = @('装饰\\总部', '装饰\\卡背')
$done=0; $skip=0; $small=0
foreach($r in $roots){
  $dir=Join-Path $root $r
  Get-ChildItem $dir -Recurse -File | Where-Object { $_.Extension -in @('.png','.jpg','.jpeg') } | ForEach-Object {
    $f=$_
    $rel=$f.FullName.Substring($root.Length+1)
    if($rel -match '中立|盟国|意（空）|法（空）|波（空）|澳（未实装）|芬（空）'){ return }
    if(Is-Jpeg $f.FullName){ $skip++; return }
    $src=[System.Drawing.Image]::FromFile($f.FullName)
    try {
      $w=$src.Width; $h=$src.Height
      if($w -gt 470){ $h=[int]($h*470/$w); $w=470 }
      $bmp=New-Object System.Drawing.Bitmap($w,$h)
      $g=[System.Drawing.Graphics]::FromImage($bmp)
      $g.Clear([System.Drawing.Color]::FromArgb(255,14,9,5))   # 深色底（融牌桌/桌面）
      $g.InterpolationMode='HighQualityBicubic'; $g.CompositingMode='SourceCopy'
      $g.DrawImage($src,0,0,$w,$h); $g.Dispose(); $src.Dispose()
      $ep=New-Object System.Drawing.Imaging.EncoderParameters(1)
      $ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]84)
      $tmp=$f.FullName+'.c3'
      $bmp.Save($tmp,$codec,$ep); $bmp.Dispose()
      $bak=Join-Path $backup $rel
      if(-not (Test-Path $bak)){ $bd=Split-Path $bak -Parent; if(-not (Test-Path $bd)){ New-Item -ItemType Directory -Force -Path $bd | Out-Null }; Copy-Item $f.FullName $bak -Force }
      Move-Item -Force $tmp $f.FullName
      $done++
    } finally { $src.Dispose() }
  }
}
Write-Output ("总部/卡背: 压缩 {0} 张（已压缩跳过 {1}）" -f $done,$skip)
`;
const enc = Buffer.from(ps, 'utf16le').toString('base64');
const out = execFileSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand', enc], { env: { ...process.env, DSH_ROOT: root }, encoding: 'utf8' });
console.log(out.trim());

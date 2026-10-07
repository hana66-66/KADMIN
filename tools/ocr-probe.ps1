# ocr-probe.ps1 —— 实测 Windows OCR 质量：整卡（放大 N 倍）+ 关键区域（放大 M 倍）
# 用法: powershell -NoProfile -File ocr-probe.ps1 -Path <卡图> [-CardScale 2] [-RegionScale 8]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [double]$CardScale = 2,
  [double]$RegionScale = 8
)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null; $task.Result
}
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
$tmp = Join-Path $env:TEMP 'ocr-probe'
if (-not (Test-Path $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }

function Ocr-Image([string]$file, [int]$scaleW, [int]$scaleH, [string]$tag) {
  $src = [System.Drawing.Image]::FromFile($file)
  $w = [int]($src.Width * $scaleW); $h = [int]($src.Height * $scaleH)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $w, $h); $g.Dispose(); $src.Dispose()
  $png = Join-Path $tmp ($tag + '.png')
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
  $st = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($st)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $st.Dispose(); $sb.Dispose()
  $out = @()
  foreach ($line in $res.Lines) {
    $ws = @($line.Words); if ($ws.Count -eq 0) { continue }
    $r = $ws[0].BoundingRect
    $out += [pscustomobject]@{ t = $line.Text; x = [int]($r.X / $scaleW); y = [int]($r.Y / $scaleH); hh = [int]($r.Height / $scaleH) }
  }
  return $out
}

$img = [System.Drawing.Image]::FromFile($Path)
$CW = $img.Width; $CH = $img.Height; $img.Dispose()
Write-Output ("=== " + (Split-Path $Path -Leaf) + "  " + $CW + "x" + $CH + " ===")
Write-Output "--- 整卡 x$CardScale ---"
Ocr-Image $Path $CardScale $CardScale 'card' | Sort-Object y, x | ForEach-Object { Write-Output ("  y=" + $_.y.ToString().PadLeft(4) + " x=" + $_.x.ToString().PadLeft(4) + " h=" + $_.hh.ToString().PadLeft(3) + "  " + $_.t) }

# 区域（按 500x702 标定坐标，自动换算到实际尺寸）
$k = $CW / 500.0
$regions = [ordered]@{
  cost = @(0, 0, 95, 78)      # 左上徽章
  fuel = @(400, 0, 100, 78)   # 右上（待确认）
  atk  = @(100, 483, 72, 75)  # 左下攻
  hp   = @(330, 483, 78, 75)  # 右下血
}
Write-Output "--- 区域 x$RegionScale ---"
foreach ($kk in $regions.Keys) {
  $r = $regions[$kk]
  $x = [int]($r[0] * $k); $y = [int]($r[1] * $k); $w = [int]($r[2] * $k); $h = [int]($r[3] * $k)
  $src = [System.Drawing.Image]::FromFile($Path)
  $crop = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($crop)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), (New-Object System.Drawing.Rectangle($x, $y, $w, $h)), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $src.Dispose()
  $big = New-Object System.Drawing.Bitmap([int]($w * $RegionScale), [int]($h * $RegionScale))
  $g2 = [System.Drawing.Graphics]::FromImage($big)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($crop, 0, 0, $big.Width, $big.Height); $g2.Dispose(); $crop.Dispose()
  $png = Join-Path $tmp ($kk + '.png'); $big.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $big.Dispose()
  $f = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($png)) ([Windows.Storage.StorageFile])
  $st = Await ($f.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($st)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $st.Dispose(); $sb.Dispose()
  $txt = ($res.Lines | ForEach-Object { $_.Text }) -join ' | '
  Write-Output ("  " + $kk.PadRight(5) + " => 「" + $txt + "」")
}

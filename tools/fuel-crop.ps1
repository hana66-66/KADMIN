param(
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Scale = 8,
  [int]$X = 80, [int]$Y = 0, [int]$W = 140, [int]$H = 130,
  [int]$Pad = 0,
  [switch]$Boost,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$Names
)
# Crop the badge region (default x80-220, y0-130 in a 500x702 card) and upscale it,
# so the fuel-cost digit can be read separately from the cost digit and the K icon.
# -Pad adds a white margin; -Boost grayscales and stretches contrast (stylized digits on art).
Add-Type -AssemblyName System.Drawing
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force -Path $Out | Out-Null }
$files = Get-ChildItem -Path (Join-Path $Src '*') -File | Where-Object { $_.Extension -match '^\.(png|jpe?g|webp|bmp)$' }
if ($Names -and $Names.Count -gt 0) {
  $files = $files | Where-Object { $n = $_.Name; ($Names | Where-Object { $n -like ('*' + $_ + '*') }).Count -gt 0 }
}
$i = 0
foreach ($f in $files) {
  try {
    $bmp = [System.Drawing.Image]::FromFile($f.FullName)
    $sx = $bmp.Width / 500.0; $sy = $bmp.Height / 702.0
    $rx = [int]([math]::Round($X * $sx)); $ry = [int]([math]::Round($Y * $sy))
    $rw = [int]([math]::Round($W * $sx)); $rh = [int]([math]::Round($H * $sy))
    if ($rx + $rw -gt $bmp.Width)  { $rw = $bmp.Width - $rx }
    if ($ry + $rh -gt $bmp.Height) { $rh = $bmp.Height - $ry }
    $dst = New-Object System.Drawing.Bitmap (($rw * $Scale) + 2 * $Pad), (($rh * $Scale) + 2 * $Pad)
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.Clear([System.Drawing.Color]::White)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    if ($Boost) {
      # grayscale + strong contrast stretch, so a stylized digit separates from the artwork behind it
      $cm = New-Object System.Drawing.Imaging.ColorMatrix
      $cm.Matrix00 = 0.299 * 2.4; $cm.Matrix01 = 0.299 * 2.4; $cm.Matrix02 = 0.299 * 2.4
      $cm.Matrix10 = 0.587 * 2.4; $cm.Matrix11 = 0.587 * 2.4; $cm.Matrix12 = 0.587 * 2.4
      $cm.Matrix20 = 0.114 * 2.4; $cm.Matrix21 = 0.114 * 2.4; $cm.Matrix22 = 0.114 * 2.4
      $cm.Matrix33 = 1.0; $cm.Matrix40 = -0.7; $cm.Matrix41 = -0.7; $cm.Matrix42 = -0.7
      $ia = New-Object System.Drawing.Imaging.ImageAttributes
      $ia.SetColorMatrix($cm)
      $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle $Pad, $Pad, ($rw * $Scale), ($rh * $Scale)), $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel, $ia)
    } else {
      $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle $Pad, $Pad, ($rw * $Scale), ($rh * $Scale)), (New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh), [System.Drawing.GraphicsUnit]::Pixel)
    }
    $g.Dispose()
    $target = Join-Path $Out ($f.BaseName + '__fuel.png')
    $dst.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    $dst.Dispose(); $bmp.Dispose()
    $i++
  } catch { Write-Output ("FAIL " + $f.Name + " : " + $_.Exception.Message) }
}
Write-Output ("cropped " + $i + " -> " + $Out)

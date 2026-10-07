param(
  [Parameter(Mandatory=$true)][string]$Src,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Cols = 4, [int]$Rows = 4,
  [int]$Scale = 6,
  [int]$X = 48, [int]$Y = 40, [int]$W = 72, [int]$H = 64,
  [int]$Pad = 20,
  [switch]$Boost,
  [Parameter(ValueFromRemainingArguments=$true)][string[]]$Names
)
# Tile the fuel-cost slot of many cards into grid sheets so one OCR request covers Cols*Rows cards.
# Writes grid_XXXX.png plus gridmap.json (sheet -> cell -> source card).
Add-Type -AssemblyName System.Drawing
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force -Path $Out | Out-Null }
$files = @(Get-ChildItem -Path (Join-Path $Src '*') -File | Where-Object { $_.Extension -match '^\.(png|jpe?g|webp|bmp)$' })
if ($Names -and $Names.Count -gt 0) {
  $files = @($files | Where-Object { $n = $_.Name; ($Names | Where-Object { $n -like ('*' + $_ + '*') }).Count -gt 0 })
}
$files = @($files | Sort-Object Name)
$perSheet = $Cols * $Rows
$cw = ($W * $Scale) + 2 * $Pad; $ch = ($H * $Scale) + 2 * $Pad
$map = @()
$sheet = 0
for ($i = 0; $i -lt $files.Count; $i += $perSheet) {
  $sheet++
  $name = 'grid_{0:D4}.png' -f $sheet
  $canvas = New-Object System.Drawing.Bitmap ($Cols * $cw), ($Rows * $ch)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.Clear([System.Drawing.Color]::Black)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $cells = @()
  for ($j = 0; $j -lt $perSheet; $j++) {
    $idx = $i + $j
    if ($idx -ge $files.Count) { break }
    $f = $files[$idx]
    $col = $j % $Cols; $row = [math]::Floor($j / $Cols)
    try {
      $bmp = [System.Drawing.Image]::FromFile($f.FullName)
      $sx = $bmp.Width / 500.0; $sy = $bmp.Height / 702.0
      $rx = [int]([math]::Round($X * $sx)); $ry = [int]([math]::Round($Y * $sy))
      $rw = [int]([math]::Round($W * $sx)); $rh = [int]([math]::Round($H * $sy))
      if ($rx + $rw -gt $bmp.Width)  { $rw = $bmp.Width - $rx }
      if ($ry + $rh -gt $bmp.Height) { $rh = $bmp.Height - $ry }
      $dx = $col * $cw; $dy = $row * $ch
      $ib = New-Object System.Drawing.Rectangle ($dx + $Pad), ($dy + $Pad), ($W * $Scale), ($H * $Scale)
      if ($Boost) {
        $cm = New-Object System.Drawing.Imaging.ColorMatrix
        $cm.Matrix00 = 0.299 * 2.4; $cm.Matrix01 = 0.299 * 2.4; $cm.Matrix02 = 0.299 * 2.4
        $cm.Matrix10 = 0.587 * 2.4; $cm.Matrix11 = 0.587 * 2.4; $cm.Matrix12 = 0.587 * 2.4
        $cm.Matrix20 = 0.114 * 2.4; $cm.Matrix21 = 0.114 * 2.4; $cm.Matrix22 = 0.114 * 2.4
        $cm.Matrix33 = 1.0; $cm.Matrix40 = -0.7; $cm.Matrix41 = -0.7; $cm.Matrix42 = -0.7
        $ia = New-Object System.Drawing.Imaging.ImageAttributes
        $ia.SetColorMatrix($cm)
        $g.DrawImage($bmp, $ib, $rx, $ry, $rw, $rh, [System.Drawing.GraphicsUnit]::Pixel, $ia)
      } else {
        $g.DrawImage($bmp, $ib, (New-Object System.Drawing.Rectangle $rx, $ry, $rw, $rh), [System.Drawing.GraphicsUnit]::Pixel)
      }
      $bmp.Dispose()
      $cells += [pscustomobject]@{ j = $j; file = $f.Name }
    } catch { Write-Output ("FAIL " + $f.Name + " : " + $_.Exception.Message) }
  }
  $g.Dispose()
  $canvas.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
  $map += [pscustomobject]@{ sheet = $name; cols = $Cols; rows = $Rows; cw = $cw; ch = $ch; cells = $cells }
}
$json = @{ sheets = @($map) } | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $Out 'gridmap.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("sheets " + $sheet + " cards " + $files.Count + " -> " + $Out)

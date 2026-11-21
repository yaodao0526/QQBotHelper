# 重新生成 desktop/icon.png（256x256，圆角渐变底 + 白色 Q）
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File desktop\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$size = 256
$pad = 10
$inner = $size - ($pad * 2)
$radius = 54
$d = $radius * 2

$bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

# 圆角矩形
$path = [System.Drawing.Drawing2D.GraphicsPath]::new()
$path.AddArc($pad, $pad, $d, $d, 180, 90)
$path.AddArc(($pad + $inner - $d), $pad, $d, $d, 270, 90)
$path.AddArc(($pad + $inner - $d), ($pad + $inner - $d), $d, $d, 0, 90)
$path.AddArc($pad, ($pad + $inner - $d), $d, $d, 90, 90)
$path.CloseFigure()

$rect = [System.Drawing.Rectangle]::new($pad, $pad, $inner, $inner)
$from = [System.Drawing.Color]::FromArgb(255, 124, 156, 255)
$to = [System.Drawing.Color]::FromArgb(255, 167, 139, 250)
$brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $from, $to, [single]45)
$g.FillPath($brush, $path)

# 白色 Q
$font = [System.Drawing.Font]::new('Segoe UI', 132, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$sf = [System.Drawing.StringFormat]::new()
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$textRect = [System.Drawing.RectangleF]::new(0, 0, [single]$size, [single]($size - 4))
$g.DrawString('Q', $font, [System.Drawing.Brushes]::White, $textRect, $sf)

$g.Dispose()
$out = Join-Path $PSScriptRoot 'icon.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved $out"

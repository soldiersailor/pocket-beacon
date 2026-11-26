# Рисует исходник иконки installer\icon-source.png (1024px) — плоский стиль:
# тёмно-синий скруглённый квадрат, синий пин-геометка с сигнальными волнами.
# Запуск: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/draw-icon-source.ps1
# Дальше скрипт make-icons.ps1 собирает из него .ico и PNG для веба.

Add-Type -AssemblyName System.Drawing

$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root "installer\icon-source.png"

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# --- фон: скруглённый квадрат с лёгким вертикальным градиентом ---
$radius = 230
$d = $radius * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Rectangle(0, 0, $size, $size)),
    [System.Drawing.Color]::FromArgb(255, 24, 35, 50),
    [System.Drawing.Color]::FromArgb(255, 13, 20, 30),
    90
)
$g.FillPath($bgBrush, $path)

# --- сигнальные волны (от центра наружу, затухают) ---
$cx = 512
$cy = 452
$waves = @(
    @(300, 70),
    @(214, 120),
    @(134, 185)
)
foreach ($w in $waves) {
    $r = $w[0]
    $alpha = $w[1]
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb($alpha, 62, 142, 235), 26)
    $g.DrawEllipse($pen, $cx - $r, $cy - $r, $r * 2, $r * 2)
    $pen.Dispose()
}

# --- пин: круг и «хвост» заливаем отдельно одинаковым цветом (без швов) ---
$blueBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 43, 125, 233))
$pr = 118
$g.FillEllipse($blueBrush, $cx - $pr, $cy - $pr, $pr * 2, $pr * 2)
$g.FillPolygon($blueBrush, @(
    [System.Drawing.Point]::new($cx - 104, $cy + 55),
    [System.Drawing.Point]::new($cx + 104, $cy + 55),
    [System.Drawing.Point]::new($cx, $cy + 186)
))

# --- белая точка в центре пина ---
$g.FillEllipse(
    (New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)),
    $cx - 40, $cy - 40, 80, 80
)

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Нарисовано: $out"

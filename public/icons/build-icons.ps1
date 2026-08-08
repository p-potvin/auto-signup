<#
.SYNOPSIS
    Renders every icon this project ships from the master artwork.

.DESCRIPTION
    One source of truth (public/icons/source/) and one command, so the toolbar
    icon, the browser tab and the iOS Home Screen cannot drift apart.

    Two rules are load-bearing rather than cosmetic:

    * Every output is fully opaque. iOS does not composite alpha in an
      `apple-touch-icon` the way a browser does — a PNG with transparent
      corners comes out as a washed grey tile on the Home Screen instead of the
      artwork. The source art is on black, so flattening costs nothing.

    * Nothing is cropped, at any size. Cropping in on the mark to fight the
      detail loss at 16px was tried and is worse: the V's arms reach the top
      corners, so a tighter crop cuts off the one shape that survives
      downsampling and leaves a gold smudge of dial and rings. Rendered whole,
      the V silhouette still reads at 32px.

    Windows-only: System.Drawing.Common has no cross-platform implementation on
    .NET 6+. The masters are committed alongside it, so this is reproducible on
    any Windows checkout without installing anything.

.EXAMPLE
    pwsh public/icons/build-icons.ps1
#>
[CmdletBinding()]
param(
    [string]$SourceDir = (Join-Path $PSScriptRoot 'source'),
    [string]$OutDir = $PSScriptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Matches --vw-bg in src/mobile/mobile.css and theme_color in the manifest, so a
# maskable icon's padding is continuous with the app's own background.
$Background = [System.Drawing.Color]::FromArgb(255, 11, 13, 18)

function Get-SquareSource {
    <# Centre-crops the master to a square, keeping the whole mark. #>
    param([System.Drawing.Image]$Image)
    $side = [Math]::Min($Image.Width, $Image.Height)
    return [System.Drawing.RectangleF]::new(
        ($Image.Width - $side) / 2,
        ($Image.Height - $side) / 2,
        $side,
        $side
    )
}

function Write-Icon {
    param(
        [System.Drawing.Image]$Image,
        [int]$Size,
        [string]$Path,
        # Fraction of the tile the artwork occupies. Below 1 the remainder is
        # background padding — what a maskable icon needs so a circular or
        # squircle mask cannot clip the mark.
        [double]$Inset = 1.0
    )

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CompositingQuality = 'HighQuality'
        $graphics.InterpolationMode = 'HighQualityBicubic'
        $graphics.PixelOffsetMode = 'HighQuality'
        $graphics.SmoothingMode = 'HighQuality'
        $graphics.Clear($Background)

        $source = Get-SquareSource -Image $Image
        # Integer destination: the only DrawImage overload taking both a float
        # source rectangle and ImageAttributes wants a Rectangle, and every size
        # here is a whole number of pixels anyway.
        $drawn = [int][Math]::Round($Size * $Inset)
        $offset = [int][Math]::Round(($Size - $drawn) / 2)
        $destination = [System.Drawing.Rectangle]::new($offset, $offset, $drawn, $drawn)

        # TightlyClamp stops the resampler reaching past the crop for
        # neighbouring pixels, which otherwise leaves a pale seam on every edge.
        $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
        try {
            $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $graphics.DrawImage(
                $Image, $destination,
                $source.X, $source.Y, $source.Width, $source.Height,
                [System.Drawing.GraphicsUnit]::Pixel, $attributes
            )
        } finally {
            $attributes.Dispose()
        }

        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host ("  {0,-26} {1}x{1}" -f (Split-Path $Path -Leaf), $Size)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Write-Ico {
    <#
        Packs PNGs into a multi-resolution .ico.

        Windows and every current browser read PNG-compressed ICO entries, so
        this is a 6-byte header plus a 16-byte directory entry per image rather
        than the BMP-with-AND-mask encoding the format originally required.
    #>
    param(
        [string[]]$PngPaths,
        [string]$Path
    )

    $images = $PngPaths | ForEach-Object {
        $bytes = [System.IO.File]::ReadAllBytes($_)
        $png = [System.Drawing.Image]::FromFile($_)
        try {
            [PSCustomObject]@{ Bytes = $bytes; Width = $png.Width; Height = $png.Height }
        } finally {
            $png.Dispose()
        }
    }

    $stream = [System.IO.File]::Create($Path)
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([UInt16]0)                 # reserved
        $writer.Write([UInt16]1)                 # type: icon
        $writer.Write([UInt16]$images.Count)

        # Image data starts after the header and the whole directory.
        $offset = 6 + (16 * $images.Count)
        foreach ($image in $images) {
            # 256 is encoded as 0; nothing here is that big, but the rule is the
            # format's, not ours.
            $writer.Write([Byte]($image.Width % 256))
            $writer.Write([Byte]($image.Height % 256))
            $writer.Write([Byte]0)               # palette size: none
            $writer.Write([Byte]0)               # reserved
            $writer.Write([UInt16]1)             # colour planes
            $writer.Write([UInt16]32)            # bits per pixel
            $writer.Write([UInt32]$image.Bytes.Length)
            $writer.Write([UInt32]$offset)
            $offset += $image.Bytes.Length
        }
        foreach ($image in $images) { $writer.Write($image.Bytes) }
    } finally {
        $writer.Dispose()
        $stream.Dispose()
    }
    Write-Host ("  {0,-26} {1} sizes" -f (Split-Path $Path -Leaf), $images.Count)
}

# --- entry ---------------------------------------------------------------

$opaqueSource = Join-Path $SourceDir 'vault-warden.png'
$cutoutSource = Join-Path $SourceDir 'vault-warden-nobg.png'
foreach ($required in @($opaqueSource, $cutoutSource)) {
    if (-not (Test-Path $required)) { throw "missing master artwork: $required" }
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$art = [System.Drawing.Image]::FromFile($opaqueSource)
$cutout = [System.Drawing.Image]::FromFile($cutoutSource)

try {
    Write-Host 'PWA / Home Screen'
    # apple-touch-icon: opaque, full bleed. iOS applies its own squircle mask,
    # so any corner rounding baked in here would be clipped twice.
    Write-Icon -Image $art -Size 180 -Path (Join-Path $OutDir 'icon-180.png')
    Write-Icon -Image $art -Size 192 -Path (Join-Path $OutDir 'icon-192.png')
    Write-Icon -Image $art -Size 512 -Path (Join-Path $OutDir 'icon-512.png')

    # Maskable: the mark sits inside the safe zone the spec guarantees is
    # visible (the middle 80%), so a circular Android mask trims padding rather
    # than the artwork.
    Write-Icon -Image $cutout -Size 512 -Path (Join-Path $OutDir 'icon-maskable-512.png') -Inset 0.78

    Write-Host 'Browser tab'
    Write-Icon -Image $art -Size 16 -Path (Join-Path $OutDir 'favicon-16.png')
    Write-Icon -Image $art -Size 32 -Path (Join-Path $OutDir 'favicon-32.png')
    Write-Icon -Image $art -Size 48 -Path (Join-Path $OutDir 'favicon-48.png')
    Write-Ico -PngPaths @(
        (Join-Path $OutDir 'favicon-16.png'),
        (Join-Path $OutDir 'favicon-32.png'),
        (Join-Path $OutDir 'favicon-48.png')
    ) -Path (Join-Path $OutDir 'favicon.ico')

    Write-Host 'Extension (manifest.json)'
    Write-Icon -Image $art -Size 16 -Path (Join-Path $OutDir 'icon16.png')
    Write-Icon -Image $art -Size 48 -Path (Join-Path $OutDir 'icon48.png')
    Write-Icon -Image $art -Size 128 -Path (Join-Path $OutDir 'icon128.png')
} finally {
    $art.Dispose()
    $cutout.Dispose()
}

Write-Host "`ndone — $OutDir"

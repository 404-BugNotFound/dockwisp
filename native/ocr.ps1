# Windows.Media.Ocr text recognition for a single PNG file.
# Uses the WinRT file/imaging APIs only (no System.Drawing) and prints the
# recognised lines to stdout, one per line. On failure it writes an
# "OCR_ERROR: ..." line to stderr and exits with a non-zero code.
param([Parameter(Mandatory = $true)][string]$Path)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]

# Block on a WinRT IAsyncOperation<T> by projecting it to a .NET Task via the
# reflected AsTask extension method (PowerShell 5.1 cannot bind the generic
# overload directly).
function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
  })[0]
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

try {
  if (-not (Test-Path -LiteralPath $Path)) {
    [Console]::Error.WriteLine("OCR_ERROR: image not found: $Path")
    exit 1
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) {
    $language = [Windows.Globalization.Language]::new("en-US")
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  }
  if (-not $engine) {
    [Console]::Error.WriteLine("OCR_ERROR: no OCR language pack available")
    exit 1
  }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = foreach ($line in $result.Lines) { $line.Text }
  [Console]::Out.WriteLine(($lines -join "`n"))
} catch {
  [Console]::Error.WriteLine("OCR_ERROR: $($_.Exception.Message)")
  exit 1
}

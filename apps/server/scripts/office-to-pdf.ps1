# Convert a Word / Excel / PowerPoint file to PDF with the locally installed
# Microsoft Office (COM automation). Opens read-only, never shows a window,
# always quits the Office instance it started.
#   powershell -NoProfile -ExecutionPolicy Bypass -File office-to-pdf.ps1 <input> <output.pdf>
param([Parameter(Mandatory = $true)][string]$InputPath, [Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
$in = (Resolve-Path -LiteralPath $InputPath).Path
$ext = [IO.Path]::GetExtension($in).ToLowerInvariant()
$app = $null
$doc = $null
try {
  switch -Regex ($ext) {
    '^\.(docx?|rtf|odt)$' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false
      $app.DisplayAlerts = 0
      $app.AutomationSecurity = 3                 # msoAutomationSecurityForceDisable: never run macros
      # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
      $doc = $app.Documents.Open($in, $false, $true, $false)
      $doc.ExportAsFixedFormat($OutputPath, 17)   # wdExportFormatPDF
      $doc.Close($false)
    }
    '^\.(xlsx?|csv|ods)$' {
      $app = New-Object -ComObject Excel.Application
      $app.Visible = $false
      $app.DisplayAlerts = $false
      $app.AutomationSecurity = 3                 # never run macros
      $app.EnableEvents = $false                  # no Workbook_Open etc.
      # Open(FileName, UpdateLinks, ReadOnly)
      $doc = $app.Workbooks.Open($in, 0, $true)
      $doc.ExportAsFixedFormat(0, $OutputPath)    # xlTypePDF
      $doc.Close($false)
    }
    '^\.(pptx?|odp)$' {
      $app = New-Object -ComObject PowerPoint.Application
      $app.AutomationSecurity = 3                 # never run macros
      # Open(FileName, ReadOnly, Untitled, WithWindow)
      $doc = $app.Presentations.Open($in, -1, 0, 0)
      $doc.SaveAs($OutputPath, 32)                # ppSaveAsPDF
      $doc.Close()
    }
    default { throw "unsupported extension: $ext" }
  }
  Write-Output "ok"
}
finally {
  if ($app) {
    try { $app.Quit() } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

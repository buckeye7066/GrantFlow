$os = Get-CimInstance Win32_OperatingSystem
$total = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
$free = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
Write-Output "Physical RAM (visible to OS): $total GiB"
Write-Output "Currently free: $free GiB"
Write-Output ""
Write-Output "Top processes by working set:"
Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 Name, @{N='MiB';E={[math]::Round($_.WorkingSet64/1MB,1)}} | Format-Table -AutoSize

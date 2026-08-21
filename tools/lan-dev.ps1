# Reach the SherERP dev server from a phone or tablet on the same wifi.
#
# WSL2 on Windows 10 runs behind its own NAT with its own address, so a device
# on the wifi cannot see the Vite server directly: it can only reach Windows.
# This forwards Windows' port 5173 to whatever address WSL currently holds, and
# opens that port on the firewall for private networks.
#
# It has to run again after every WSL restart, because WSL is handed a new
# address each time it boots. That is the whole reason this is a script and not
# a one-line instruction.
#
# Windows 11 22H2 and later can skip all of this with mirrored networking
# (`networkingMode=mirrored` in `%USERPROFILE%\.wslconfig`). This machine is
# Windows 10 build 19045, which does not support it.
#
# Run in an **Administrator** PowerShell:
#     powershell -ExecutionPolicy Bypass -File \\wsl$\...\tools\lan-dev.ps1

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'

$port = 5173
$ruleName = 'SherERP dev server (Vite 5173)'

$wslIp = (wsl.exe -- hostname -I).Trim().Split(' ')[0]
if ([string]::IsNullOrWhiteSpace($wslIp)) {
    throw 'Could not read the WSL address. Is WSL running? Try `wsl -- hostname -I` first.'
}

# Replaced rather than added to: a stale rule pointing at the address WSL held
# before its last restart is worse than none, because the port answers and then
# hangs instead of failing fast.
netsh interface portproxy delete v4tov4 listenport=$port listenaddress=0.0.0.0 2>$null | Out-Null
netsh interface portproxy add v4tov4 listenport=$port listenaddress=0.0.0.0 connectport=$port connectaddress=$wslIp | Out-Null

if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private | Out-Null
    Write-Host "Firewall rule created: $ruleName"
}

# The rule above covers Private networks only. On a Public profile Windows drops
# the connection and the phone just times out with nothing to read, so say so
# here rather than letting it look like a broken dev server.
#
# Not changed automatically: a network profile decides how this machine is
# exposed to every service on that network, not just this dev server, so it is
# the owner's call. The exact command is printed instead of a menu path.
$publicProfiles = @(Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' })
if ($publicProfiles.Count -gt 0) {
    Write-Warning 'This network is set to a Public profile, so the firewall rule above will NOT apply and the phone will time out.'
    Write-Warning 'Fix it in this same admin window with:'
    foreach ($profile in $publicProfiles) {
        Write-Warning "    Set-NetConnectionProfile -InterfaceIndex $($profile.InterfaceIndex) -NetworkCategory Private   # $($profile.Name)"
    }
}

# The address to hand the phone is the one on the adapter that actually reaches
# the wifi — meaning the one holding a default gateway.
#
# Picking "the first address that is not loopback" instead is what printed a
# 169.254.x.x here: that is an APIPA link-local address, which Windows invents
# for an adapter with no working DHCP (an unplugged ethernet port, a dormant
# Hyper-V switch), and no phone can ever reach it. An adapter with a default
# gateway is one with a real network behind it.
$lanIp = (Get-NetIPConfiguration |
    Where-Object { $null -ne $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    Select-Object -First 1).IPv4Address.IPAddress

if ([string]::IsNullOrWhiteSpace($lanIp)) {
    Write-Warning 'No adapter with a default gateway found. Candidates, pick the one on your wifi:'
    Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Format-Table InterfaceAlias, IPAddress -AutoSize
    $lanIp = '<your Windows LAN address>'
}

Write-Host ''
Write-Host "WSL is at $wslIp, forwarding Windows port $port to it."
Write-Host ''
Write-Host "On your phone or tablet, open:  http://${lanIp}:${port}"
Write-Host ''
Write-Host 'Start both halves inside WSL first:'
Write-Host '    pnpm dev                       (the API, port 3000)'
Write-Host '    pnpm --filter @sher/web dev    (the app, port 5173)'

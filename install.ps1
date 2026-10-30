# install.ps1 — install or remove dsh-myops in a DSH profile.
#
# 覆盖或卸载前一定先备份已有的 dsh-myops（插件目录 + cordis.patch.yml），
# 备份放在 <工作区>\.backups\myops-<时间戳>\，校验字节数一致后才继续。
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -BackupOnly
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Restore ".backups\myops-20261031-025940"
# Optional:
#   -ProfileDir "C:\Users\<you>\.dsh\profiles\desktop"
#   -BackupRoot "<workspace>\.backups"

param(
    [switch]$Uninstall,
    [switch]$BackupOnly,
    [string]$Restore,
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$BackupRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) '.backups')
)

$ErrorActionPreference = 'Stop'
$Source = $PSScriptRoot
$Target = Join-Path $ProfileDir 'node_modules\dsh-myops'
$PatchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$Files = @('package.json', 'index.mjs', 'client.js', 'cordis.patch.yml', 'README.md')
# 子目录（lib/ 等）需要递归复制，否则装到 profile 里会缺模块
$Directories = @('lib')

$RowBlock = @"

# dsh-myops: Git Bash + compact file tools (added by install.ps1).
- insert:
    - id: myops
      name: dsh-myops
"@

function Get-Bytes([string]$Path) {
    if (-not (Test-Path $Path)) { return 0 }
    $sum = (Get-ChildItem $Path -Recurse -File -Force -ErrorAction SilentlyContinue |
            Measure-Object Length -Sum).Sum
    if ($null -eq $sum) {
        if (Test-Path $Path -PathType Leaf) { return (Get-Item $Path).Length }
        return 0
    }
    return [int64]$sum
}

# <summary>覆盖/删除之前备份现有 myops。返回备份目录，没有可备份内容时返回 $null。</summary>
function Backup-Myops([string]$Reason, [string]$Action) {
    $hasPlugin = Test-Path $Target
    $hasPatchRow = (Test-Path $PatchFile) -and ((Get-Content $PatchFile -Raw) -match '(?m)^# dsh-myops:')
    if (-not $hasPlugin -and -not $hasPatchRow) { return $null }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $session = Join-Path $BackupRoot "myops-$stamp"
    New-Item -ItemType Directory -Path $session -Force | Out-Null

    $entries = @()

    if ($hasPlugin) {
        $dest = Join-Path $session 'dsh-myops'
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Copy-Item (Join-Path $Target '*') $dest -Recurse -Force
        $src = Get-Bytes $Target
        $dst = Get-Bytes $dest
        if ($src -ne $dst) { throw "备份校验失败（插件目录）: 源 $src 字节, 备份 $dst 字节" }
        $entries += [pscustomobject]@{ source = $Target; backup = $dest; bytes = $src }
        Write-Host "已备份插件目录: $Target -> $dest ($src 字节)"
    }

    if ($hasPatchRow) {
        $dest = Join-Path $session 'cordis.patch.yml'
        Copy-Item $PatchFile $dest -Force
        $src = (Get-Item $PatchFile).Length
        $dst = (Get-Item $dest).Length
        if ($src -ne $dst) { throw "备份校验失败（cordis.patch.yml）: 源 $src 字节, 备份 $dst 字节" }
        $entries += [pscustomobject]@{ source = $PatchFile; backup = $dest; bytes = $src }
        Write-Host "已备份配置: $PatchFile -> $dest ($src 字节)"
    }

    $manifest = [pscustomobject]@{
        plugin     = 'dsh-myops'
        time       = $stamp
        action     = $Action
        reason     = $Reason
        entries    = $entries
        restoreTip = "powershell -ExecutionPolicy Bypass -File '$PSCommandPath' -Restore '$session'"
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $session 'manifest.json') -Encoding UTF8
    Write-Host "备份目录: $session"
    return $session
}

# ---------------- restore ----------------
if ($Restore) {
    if (-not (Test-Path $Restore)) { throw "找不到备份目录: $Restore" }
    $pluginBak = Join-Path $Restore 'dsh-myops'
    $patchBak = Join-Path $Restore 'cordis.patch.yml'
    if (-not (Test-Path $pluginBak) -and -not (Test-Path $patchBak)) {
        throw "备份目录里没有 dsh-myops 或 cordis.patch.yml: $Restore"
    }

    # 恢复前先备份当前版本，避免恢复本身把现状弄丢
    $safety = Backup-Myops -Reason '恢复前备份当前版本' -Action 'pre-restore'
    if ($safety) { Write-Host "当前版本已备份到: $safety" }

    if (Test-Path $pluginBak) {
        New-Item -ItemType Directory -Path $Target -Force | Out-Null
        Copy-Item (Join-Path $pluginBak '*') $Target -Recurse -Force
        Write-Host "已恢复插件目录: $pluginBak -> $Target"
    }
    if (Test-Path $patchBak) {
        Copy-Item $patchBak $PatchFile -Force
        Write-Host "已恢复配置: $patchBak -> $PatchFile"
    }
    Write-Host "恢复完成。请重启 DSH 桌面端。"
    exit 0
}

# ---------------- uninstall ----------------
if ($Uninstall) {
    $backupDir = Backup-Myops -Reason '卸载 dsh-myops' -Action 'uninstall'

    if (Test-Path $Target) {
        Remove-Item -Recurse -Force $Target
        Write-Host "已删除 $Target"
    } else {
        Write-Host "未安装: $Target"
    }

    if (Test-Path $PatchFile) {
        $text = Get-Content $PatchFile -Raw
        if ($text -match '(?m)^# dsh-myops:') {
            $pattern = "(?ms)\r?\n# dsh-myops:.*?name:\s*dsh-myops\s*"
            $new = [regex]::Replace($text, $pattern, "`n")
            Set-Content -Path $PatchFile -Value $new -NoNewline
            Write-Host "已从 $PatchFile 移除 dsh-myops 行"
        } else {
            Write-Host "$PatchFile 中没有 dsh-myops 行"
        }
    }

    if ($backupDir) { Write-Host "可从以下位置恢复: $backupDir" }
    Write-Host "完成。请重启 DSH 桌面端。"
    exit 0
}

# ---------------- backup only ----------------
if ($BackupOnly) {
    $dir = Backup-Myops -Reason '手动备份 dsh-myops' -Action 'backup'
    if (-not $dir) { Write-Host '没有可备份的 dsh-myops。' }
    exit 0
}

# ---------------- install ----------------
if (-not (Test-Path $ProfileDir)) {
    throw "找不到 profile 目录: $ProfileDir"
}

$backupDir = Backup-Myops -Reason '覆盖安装前备份旧版 dsh-myops' -Action 'replace'

New-Item -ItemType Directory -Path (Split-Path $Target) -Force | Out-Null
# 不要先删除 $Target：宿主会监听文件变化并热加载，
# 目录短暂不存在会导致应用报 ERR_MODULE_NOT_FOUND / unknown tool ops_bash。
New-Item -ItemType Directory -Path $Target -Force | Out-Null
foreach ($item in $Files) {
    Copy-Item (Join-Path $Source $item) (Join-Path $Target $item) -Force
}
foreach ($dir in $Directories) {
    $srcDir = Join-Path $Source $dir
    if (-not (Test-Path $srcDir)) { continue }
    $dstDir = Join-Path $Target $dir
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
    # 复制目录内容而不是目录本身，避免出现 lib\lib 嵌套
    Copy-Item (Join-Path $srcDir '*') $dstDir -Recurse -Force
}

# 移除历史版本安装残留（v2.0.0 删除了文档类工具）：避免 profile 里留下不再使用的死代码
$Obsolete = @('lib\doc-tools.mjs', 'lib\vendor')
foreach ($rel in $Obsolete) {
    $leftover = Join-Path $Target $rel
    if (Test-Path $leftover) {
        Remove-Item -Recurse -Force $leftover
        Write-Host "已移除废弃文件: $leftover"
    }
}
Write-Host "已复制插件到 $Target"

if (-not (Test-Path $PatchFile)) {
    New-Item -ItemType File -Path $PatchFile -Force | Out-Null
    Set-Content -Path $PatchFile -Value '[]' -NoNewline
}
$text = Get-Content $PatchFile -Raw
if ($text -match '(?m)^# dsh-myops:') {
    Write-Host "$PatchFile 中已存在 dsh-myops 行，保持不变。"
} else {
    Add-Content -Path $PatchFile -Value $RowBlock
    Write-Host "已向 $PatchFile 追加 dsh-myops 行"
}

Write-Host ""
if ($backupDir) { Write-Host "旧版已备份到: $backupDir" }
Write-Host "安装完成。重启 DSH 桌面端后开新会话即可使用。"
Write-Host "工具: ops_bash, ops_read, ops_glob, ops_grep, ops_write, ops_edit, ops_stat, ops_result, ops_git"

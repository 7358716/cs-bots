# 取证脚本：查「导入后部门和 Bot 消失」

## 怎么用（Win 桌面版 DSH 那台机器）

1. 开始菜单搜 **PowerShell**，打开（**普通模式即可，不需要管理员**）
2. 整段复制下面代码，右键粘贴进去，回车
3. 把屏幕输出截图或复制回来

---

```powershell
Write-Host "=== 1. cs-bots 状态目录（看 settings 备份，pre-import 就是导入时落的）==="
Get-ChildItem "$env:USERPROFILE\.dsh\cs-bots\settings.json*" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime |
  Format-Table Name, Length, LastWriteTime -AutoSize

Write-Host "=== 2. Bot 注册表快照 ==="
Get-ChildItem "$env:USERPROFILE\.dsh\cs-bots\roster.snap.json*" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime |
  Format-Table Name, Length, LastWriteTime -AutoSize

Write-Host "=== 3. 会话目录：导入前后的会话文件还在不在 ==="
if (Test-Path "$env:USERPROFILE\.dsh\sessions") {
  Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -File |
    Sort-Object LastWriteTime |
    Select-Object -Last 30 Name, Length, LastWriteTime |
    Format-Table -AutoSize
} else {
  Write-Host "会话目录不存在：$env:USERPROFILE\.dsh\sessions"
}

Write-Host "=== 4. 当前部门表（id / 显示名）==="
$s = Get-Content "$env:USERPROFILE\.dsh\cs-bots\settings.json" -Raw | ConvertFrom-Json
$s.departments | Format-Table id, name -AutoSize

Write-Host "=== 5. 当前注册表里的 Bot（按创建时间排序）==="
$r = Get-Content "$env:USERPROFILE\.dsh\cs-bots\roster.snap.json" -Raw | ConvertFrom-Json
$r.bots |
  Select-Object name, state,
    @{n='created'; e={[DateTimeOffset]::FromUnixTimeMilliseconds([int64]$_.createdAt).ToString('yyyy-MM-dd HH:mm:ss')}},
    @{n='cwd'; e={$_.cwd}} |
  Sort-Object created |
  Format-Table -AutoSize

Write-Host "=== 6. 主目录下实际有哪些目录（前两层）==="
Get-ChildItem "$env:USERPROFILE\.dsh\cs-bots" -Directory -ErrorAction SilentlyContinue |
  ForEach-Object {
    $d = $_
    "{0}\" -f $d.Name
    Get-ChildItem $d.FullName -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { "    {0}" -f $_.Name }
  }
```

---

## 每个输出能回答什么

| 段 | 判定 |
|---|---|
| 1. 有 `settings.json.pre-import-*` | 导入时确实覆盖过设置 → 从备份能精确取回你新建的部门 |
| 2. `roster.snap.json` 的 mtime 早于你建 Bot 的时刻 | 注册表被整体回退 → Bot 是从注册表掉的 |
| 3. 会话目录里还有那些会话文件 | **对话没真丢**，只是 Bot 从注册表掉了，能挂回去 |
| 3. 会话文件也没了 | 会话真的被清理了，得看你导入时勾了什么 |
| 5. `created` 时间 | 和你建 Bot 的时间对得上就能确认是谁建的、什么时候掉的 |
| 6. 主目录下的目录 | 目录还在、注册表里没了 = 只掉注册表；两边都没 = 整体被覆盖 |

---

## 如果段 1 有 pre-import 备份，恢复方法（我会给你精确命令）

```powershell
# 只读查看备份里的部门（不会改任何东西）
Get-Content "$env:USERPROFILE\.dsh\cs-bots\settings.json.pre-import-<时间戳>" -Raw |
  ConvertFrom-Json | Select-Object -ExpandProperty departments
```

看到你新建的部门在备份里，我就能给出只补回这几个部门、不动其它数据的命令。
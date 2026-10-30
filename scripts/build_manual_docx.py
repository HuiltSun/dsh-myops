"""Build the dsh-myops user manual (.docx) with python-docx."""

from datetime import date
from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor, Emu

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "deliverables" / "dsh-myops_使用手册_v2.2.2.docx"

VERSION = "2.2.2"
TODAY = date.today().strftime("%Y-%m-%d")
BODY_FONT_EA = "宋体"
BODY_FONT = "Calibri"
HEAD_FONT_EA = "黑体"


# --------------------------------------------------------------------------- #
# style helpers
# --------------------------------------------------------------------------- #

def set_east_asia(rpr_owner, font_name: str) -> None:
    element = getattr(rpr_owner, "_r", None)
    if element is None:
        element = getattr(rpr_owner, "_element", None)
    if element is None:
        element = rpr_owner
    rpr = element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), font_name)
    rfonts.set(qn("w:ascii"), BODY_FONT)
    rfonts.set(qn("w:hAnsi"), BODY_FONT)


def shade_paragraph(paragraph, fill: str = "F2F2F2") -> None:
    ppr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    ppr.append(shd)


def add_page_number_footer(section) -> None:
    footer = section.footer
    paragraph = footer.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run()
    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run._r.append(fld_begin)
    run._r.append(instr)
    run._r.append(fld_end)
    for r in paragraph.runs:
        r.font.size = Pt(9)
        r.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
        set_east_asia(r, BODY_FONT_EA)


def code_block(doc, text: str) -> None:
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.left_indent = Cm(0.5)
    paragraph.paragraph_format.space_before = Pt(4)
    paragraph.paragraph_format.space_after = Pt(6)
    paragraph.paragraph_format.line_spacing = 1.05
    shade_paragraph(paragraph)
    run = paragraph.add_run(text)
    run.font.name = "Consolas"
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x33, 0x33, 0x33)
    set_east_asia(run, "等线")


def bullet(doc, text: str, bold_lead: str | None = None) -> None:
    paragraph = doc.add_paragraph(style="List Bullet")
    paragraph.paragraph_format.space_after = Pt(2)
    if bold_lead:
        lead = paragraph.add_run(bold_lead)
        lead.bold = True
        set_east_asia(lead, BODY_FONT_EA)
        paragraph.add_run(text)
    else:
        paragraph.add_run(text)
    for run in paragraph.runs:
        run.font.size = Pt(10.5)
        set_east_asia(run, BODY_FONT_EA)


def body(doc, text: str) -> None:
    paragraph = doc.add_paragraph()
    paragraph.paragraph_format.space_after = Pt(6)
    run = paragraph.add_run(text)
    run.font.size = Pt(10.5)
    set_east_asia(run, BODY_FONT_EA)


def heading(doc, text: str, level: int = 1) -> None:
    paragraph = doc.add_heading("", level=level)
    run = paragraph.add_run(text)
    run.font.size = Pt(15 if level == 1 else 12)
    run.font.bold = True
    run.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
    set_east_asia(run, HEAD_FONT_EA)
    paragraph.paragraph_format.space_before = Pt(14 if level == 1 else 10)
    paragraph.paragraph_format.space_after = Pt(4)


def add_table(doc, headers, rows, widths=None, font_size=9.5):
    table = doc.add_table(rows=1, cols=len(headers))
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    header_cells = table.rows[0].cells
    for index, text in enumerate(headers):
        cell = header_cells[index]
        cell.text = ""
        paragraph = cell.paragraphs[0]
        run = paragraph.add_run(text)
        run.bold = True
        run.font.size = Pt(font_size)
        set_east_asia(run, HEAD_FONT_EA)
        fill = OxmlElement("w:shd")
        fill.set(qn("w:val"), "clear")
        fill.set(qn("w:color"), "auto")
        fill.set(qn("w:fill"), "DCE6F1")
        cell._tc.get_or_add_tcPr().append(fill)
    for row in rows:
        cells = table.add_row().cells
        for index, value in enumerate(row):
            cells[index].text = ""
            paragraph = cells[index].paragraphs[0]
            run = paragraph.add_run(str(value))
            run.font.size = Pt(font_size)
            set_east_asia(run, BODY_FONT_EA)
    if widths:
        for row in table.rows:
            for index, width in enumerate(widths):
                row.cells[index].width = Cm(width)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return table


# --------------------------------------------------------------------------- #
# document
# --------------------------------------------------------------------------- #

def build() -> Path:
    doc = Document()

    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.4)
    section.right_margin = Cm(2.4)
    add_page_number_footer(section)

    normal = doc.styles["Normal"]
    normal.font.name = BODY_FONT
    normal.font.size = Pt(10.5)
    set_east_asia(normal, BODY_FONT_EA)
    normal.paragraph_format.line_spacing = 1.35
    normal.paragraph_format.space_after = Pt(6)

    doc.core_properties.title = "dsh-myops 使用手册"
    doc.core_properties.subject = "DSH Desktop 插件：Git Bash 与高效文件工具"
    doc.core_properties.author = "dsh-myops"
    doc.core_properties.comments = f"v{VERSION} · {TODAY}"

    # ---------- cover ----------
    for _ in range(3):
        doc.add_paragraph()

    title = doc.add_paragraph()
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title_run = title.add_run("dsh-myops 使用手册")
    title_run.font.size = Pt(28)
    title_run.font.bold = True
    title_run.font.color.rgb = RGBColor(0x1F, 0x3A, 0x5F)
    set_east_asia(title_run, HEAD_FONT_EA)

    subtitle = doc.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    subtitle_run = subtitle.add_run("DSH Desktop 的 Git Bash 与高效文件工具插件")
    subtitle_run.font.size = Pt(13)
    subtitle_run.font.color.rgb = RGBColor(0x55, 0x66, 0x77)
    set_east_asia(subtitle_run, BODY_FONT_EA)

    meta = doc.add_paragraph()
    meta.alignment = WD_ALIGN_PARAGRAPH.CENTER
    meta_run = meta.add_run(f"版本 {VERSION}    ·    {TODAY}    ·    Windows / DSH Desktop")
    meta_run.font.size = Pt(10)
    meta_run.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
    set_east_asia(meta_run, BODY_FONT_EA)

    overview = doc.add_paragraph()
    overview.alignment = WD_ALIGN_PARAGRAPH.CENTER
    overview.paragraph_format.space_before = Pt(26)
    overview_run = overview.add_run(
        "9 个工具 · 零 npm 依赖 · 面向 token 消耗优化的默认值\n"
        "文档格式（Word/Excel/PPT/PDF/CSV）由 /office 技能系列处理"
    )
    overview_run.font.size = Pt(10.5)
    overview_run.font.color.rgb = RGBColor(0x44, 0x55, 0x66)
    set_east_asia(overview_run, BODY_FONT_EA)

    doc.add_page_break()

    # ---------- 1. 简介 ----------
    heading(doc, "1. 简介")
    body(doc, "dsh-myops 是 DSH Desktop 的本地插件，用 Git Bash 替代 PowerShell，"
              "并提供一套紧凑、对模型友好的文件与 Git 工具。插件本身零 npm 依赖、"
              "无原生二进制；安装后与官方工具同时可用，也可以选择隐藏官方工具，"
              "只保留一套工具面以减少每轮请求的工具定义开销。")
    bullet(doc, "：运行命令走 Git Bash（Windows），支持管道、重定向与常见 Unix 工具。", "ops_bash")
    bullet(doc, "：9 个工具覆盖命令、读写、搜索、Git 与大输出翻页；默认值针对 token 优化。", "工具面")
    bullet(doc, "：Word / Excel / PPT / PDF / CSV 不在插件范围内，统一使用 /office 技能"
                "（office-docx、office-xlsx、office-pptx、office-render、office-export-pdf）。", "文档处理")

    # ---------- 2. 快速开始 ----------
    heading(doc, "2. 快速开始")
    body(doc, "在插件目录执行安装脚本，然后重启 DSH 桌面端：")
    code_block(doc, "powershell -ExecutionPolicy Bypass -File .\\install.ps1")
    body(doc, "重启后打开 Settings → myops 工具，选择一个配置档（默认「均衡」），即可开始使用。"
              "之后在会话中直接调用 ops_* 工具，例如：")
    code_block(doc,
               "ops_bash:   git status\n"
               "ops_read:   README.md（默认前 800 行）\n"
               "ops_grep:   pattern=\"TODO\" include=\"**/*.mjs\"\n"
               "ops_git:    action=\"status\"")

    # ---------- 3. 安装、升级与备份 ----------
    heading(doc, "3. 安装、升级与备份")
    body(doc, "安装脚本会在覆盖前自动备份当前插件目录与 cordis.patch.yml，"
              "校验字节数一致后才继续复制；升级时还会清理历史版本残留的废弃文件。")
    add_table(doc,
              ["命令", "作用"],
              [
                  [".\\install.ps1", "安装 / 升级到当前版本（先备份）"],
                  [".\\install.ps1 -BackupOnly", "只备份，不改动安装"],
                  [".\\install.ps1 -Restore \"备份目录\"", "回滚到指定备份（回滚前先备份现状）"],
                  [".\\install.ps1 -Uninstall", "卸载（先备份，再删除插件与配置行）"],
              ],
              widths=[7.0, 8.0])
    body(doc, "备份位置：E:\\.backups\\myops-<时间戳>\\，包含 manifest.json 与完整的插件副本。"
              "安装或修改配置后需要重启 DSH 桌面端；插件不会热加载新的工具定义。")

    # ---------- 4. 工具一览 ----------
    heading(doc, "4. 工具一览")
    add_table(doc,
              ["工具", "用途"],
              [
                  ["ops_bash", "Git Bash 执行命令；超时终止进程树"],
                  ["ops_read", "按行读取文本，offset/limit 翻页；全文重复读会去重（按智能体隔离）"],
                  ["ops_glob", "按 glob 查找文件；stat=true 附带大小与 mtime"],
                  ["ops_grep", "正则搜索文件内容；include / exclude / 大小写"],
                  ["ops_write", "写 UTF-8 文件；dryRun、ifNotExists、expectedRevision"],
                  ["ops_edit", "精确字符串替换；多块、原子、dryRun、expectedRevision"],
                  ["ops_stat", "类型/大小/mtime/行数/sha256；paths 批量"],
                  ["ops_result", "分页读取 spill 的大输出"],
                  ["ops_git", "status / diff / log / show / branch / add / commit"],
              ],
              widths=[3.6, 11.4])

    # ---------- 5. 常用用法 ----------
    heading(doc, "5. 常用用法")
    heading(doc, "5.1 ops_bash", level=2)
    body(doc, "返回值包含 stdout、stderr 与非零退出码；成功时只输出命令结果（不再附加 exit code / 耗时），"
              "失败、超时或耗时 ≥2s 才附元信息。超时会终止整棵进程树，返回 timed out 提示。")
    code_block(doc,
               "ops_bash { command: \"pwd -W\", workdir: \"src\" }\n"
               "ops_bash { command: \"npm test\", timeoutMs: 300000, login: true }")
    bullet(doc, "：默认 auto（优先宿主 subprocess 服务，失败降级直连）；direct 强制直连回退，"
                "service 强制要求服务（不可用即报错）。", "mode")
    bullet(doc, "：使用 bash -lc，加载 /etc/profile 与用户 profile；默认 bash -c 更快。", "login")

    heading(doc, "5.2 读取与搜索", level=2)
    bullet(doc, "：默认前 800 行；全文读取第二次返回 unchanged 提示，force=true 可强制重打；"
                "windowed 读取总是返回内容；头部带文件 rev（sha256 前缀，可传给 expectedRevision）。"
                "去重状态按智能体/会话隔离，子智能体不会把调用方的读取变成假 unchanged。", "ops_read")
    bullet(doc, "：include 是单个 glob，不会自动递归（用 **/*.mjs）；>5 MB 文件与二进制跳过；"
                "exclude 是内容排除正则。", "ops_grep")

    heading(doc, "5.3 写入与修改", level=2)
    bullet(doc, "：dryRun 预演、createDirs、ifNotExists、expectedRevision（sha256 前缀）防止覆盖并发修改。", "ops_write")
    bullet(doc, "：每个 oldText 必须在文件中恰好出现一次；全部校验通过才落盘；支持多块编辑，"
                "CRLF/CR 匹配前统一为 LF；expectedRevision（sha256 前缀）可在并发修改时拒绝覆盖。", "ops_edit")

    heading(doc, "5.4 大输出与 ops_result", level=2)
    body(doc, "单次输出超过 maxOutputChars 时会落盘到 %TEMP%\\dsh-myops-spill\\，"
              "模型只收到不超过 8000 字符的预览和 [full output id=…] 提示；"
              "用 ops_result(id, offset, limit) 翻页读取完整内容。对应临时目录在插件启动时清理 7 天前文件，"
              "写入时最多保留 200 条。")

    heading(doc, "5.5 ops_git", level=2)
    body(doc, "直接调用 git（无 shell、无分页器、禁止交互提示）：status 汇总分支与暂存/未暂存/未跟踪；"
              "diff 默认 --stat（stat=false 输出补丁）；log 一行式；add/commit 只作用于显式 paths。"
              "push、merge、rebase、reset 仍通过 ops_bash 执行，便于审阅具体命令。")

    # ---------- 6. 会话工作目录 ----------
    heading(doc, "6. 会话工作目录与相对路径")
    body(doc, "所有路径型工具的相对路径与 ops_bash 的默认 workdir 都按“会话工作目录”解析"
              "（DSH workingDirectory 服务；无该服务时用 session header 兜底），不再落到宿主进程目录。"
              "显式 workdir 与绝对路径仍然优先。")

    # ---------- 7. 设置页 ----------
    heading(doc, "7. Desktop 设置页")
    body(doc, "Settings → myops 工具 可完成日常调整，无需手改配置文件：")
    add_table(doc,
              ["控件", "作用", "生效方式"],
              [
                  ["配置档（直接选择）", "token-saver / balanced / generous / debug-official / quiet-code", "点击即应用"],
                  ["模型可见输出上限", "maxOutputChars（1,000 – 2,000,000）", "立即生效"],
                  ["ops_bash 默认超时", "bashTimeoutMs（1,000 – 2,147,483,647 毫秒）", "立即生效"],
                  ["屏蔽官方工具", "hideOfficial（pwsh/read/glob/grep/write/edit）", "重启生效"],
              ],
              widths=[4.2, 7.4, 3.4])
    body(doc, "设置持久化在 %USERPROFILE%\\.dsh\\myops-settings.json；损坏或缺失时回落到插件配置默认值。"
              "设置接口仅接受本机同源请求（localhost、JSON，≤64 KB）。")

    # ---------- 8. 配置档 ----------
    heading(doc, "8. 配置档（Presets）")
    body(doc, "除设置页按钮外，也可以用命令行切换配置档，脚本会先备份再写入：")
    code_block(doc,
               "node scripts/apply-preset.mjs list\n"
               "node scripts/apply-preset.mjs token-saver\n"
               "node scripts/apply-preset.mjs balanced --dry-run")
    add_table(doc,
              ["档位", "输出上限", "默认超时", "官方工具"],
              [
                  ["token-saver 极致省 token", "12000", "120 s", "隐藏全部 6 个"],
                  ["balanced 均衡（默认）", "24000", "120 s", "隐藏全部 6 个"],
                  ["generous 宽松", "60000", "300 s", "隐藏全部 6 个"],
                  ["debug-official 调试", "60000", "120 s", "不隐藏"],
                  ["quiet-code 只隐藏读类", "24000", "120 s", "隐藏 read/glob/grep"],
              ],
              widths=[6.0, 3.2, 3.0, 3.8])
    body(doc, "配置档同时维护在 configs/myops-presets.json；设置页内置同一份副本，"
              "两处数值需要保持一致。")

    # ---------- 9. Token 优化 ----------
    heading(doc, "9. Token 优化默认值")
    add_table(doc,
              ["默认项", "值", "效果"],
              [
                  ["模型可见输出上限", "24000 字符", "超限时只回 ≤8k 字符预览 + ops_result id"],
                  ["ops_read 默认行数", "800", "3000 行文件返回约 8k 字符而不是约 60k"],
                  ["ops_glob 结果上限", "100", "限制最坏输出，与官方 glob 上限对齐"],
                  ["ops_grep 匹配上限", "120", "限制最坏输出"],
                  ["ops_bash 成功输出", "仅 stdout", "不再附加 exit code / 耗时"],
                  ["hideOfficial", "6 个官方工具", "工具面只保留一套，减少每轮固定开销"],
              ],
              widths=[5.0, 4.0, 6.8])
    body(doc, "实测：9 个工具定义约 6411 字符（约 1801 tokens）/ 请求（精简前约 9098 字符 / 2527 tokens）；"
              "大文件读取的模型可见输出从 59968 字符降到 8084 字符。")

    # ---------- 10. 测试 ----------
    heading(doc, "10. 测试与自检")
    body(doc, "插件内置两套无外部依赖的测试，修改代码后运行：")
    code_block(doc,
               "node test/smoke.mjs   # 34 项：注册、bash、写/改/查安全语义、去重、glob/grep、spill 翻页\n"
               "node test/bench.mjs   # 65 项：延迟与输出成本、超时/进程树、cwd 绑定、参数、ops_git、设置页")
    body(doc, "bench 会写 test/bench-report.json。失败项对应关系：超时/残留 → 进程树终止；"
              "会话 cwd → resolveSessionCwd 接线；注册失败 → 语法/导入；设置项 → store 或路由；"
              "mode/exclude/stat 等 → 对应参数路径。")

    # ---------- 11. 已知限制 ----------
    heading(doc, "11. 已知限制")
    bullet(doc, "：绕过 DSH 文件沙盒，以宿主用户权限运行，可读写整个用户目录；插件没有更细粒度的路径/命令白名单。", "ops_bash")
    bullet(doc, "：spill 目录为临时存储，只在插件启动与写入时清理（7 天 TTL / 200 条），没有后台定时器。", "ops_result")
    bullet(doc, "：纯 JS 实现，无 ripgrep；>5 MB 单文件直接跳过，无流式扫描。", "ops_grep")
    bullet(doc, "：是便捷封装而非完整 Git 客户端，不提供 push/fetch/merge/rebase/reset。", "ops_git")
    bullet(doc, "：设置页需要 DSH Web/Desktop 挂载 webServer 服务；client.js 与 hideOfficial 变更需重启。", "设置页")

    # ---------- 12. 版本摘要 ----------
    heading(doc, "12. 版本摘要")
    add_table(doc,
              ["版本", "要点"],
              [
                  ["2.2.2", "读去重按智能体隔离；ops_edit 支持 expectedRevision；ops_read 输出 rev"],
                  ["2.2.1", "ops_glob 结果上限 200 → 100，与官方 glob 对齐"],
                  ["2.2.0", "设置页新增配置档一键选择"],
                  ["2.1.0", "token 优化：默认值下调、spill 小预览、bash 成功静默、描述精简"],
                  ["2.0.0", "移除文档类工具（read_table/docx/pdf），文档交给 /office 技能"],
                  ["1.4.0", "Desktop 设置页（maxOutputChars / bashTimeoutMs / hideOfficial）"],
                  ["1.3.0", "新增 ops_git"],
                  ["1.2.0", "Windows 超时进程树终止、会话工作目录绑定、mode/login/exclude/stat 等参数"],
                  ["1.1.0", "零依赖实现 11 个工具、spill、去重与文档解析"],
              ],
              widths=[2.6, 12.4])

    doc.add_page_break()
    closing = doc.add_paragraph()
    closing.alignment = WD_ALIGN_PARAGRAPH.CENTER
    closing_run = closing.add_run("— 文档结束 —")
    closing_run.font.size = Pt(10)
    closing_run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
    set_east_asia(closing_run, BODY_FONT_EA)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    return OUT


def verify(path: Path) -> None:
    doc = Document(path)
    headings = [p.text for p in doc.paragraphs if p.style.name.startswith("Heading")]
    assert headings, "no headings found"
    required = ["1. 简介", "4. 工具一览", "7. Desktop 设置页", "9. Token 优化默认值", "12. 版本摘要"]
    for item in required:
        assert item in headings, f"missing heading: {item}"
    tables = doc.tables
    assert len(tables) == 6, f"expected 6 tables, got {len(tables)}"
    text = "\n".join(p.text for p in doc.paragraphs)
    for needle in ["ops_bash", "24000", "token-saver", "hideOfficial", "8k 字符"]:
        assert needle in text or any(needle in cell.text for table in tables for row in table.rows for cell in row.cells), f"missing text: {needle}"
    assert "9 个工具" in text
    print(f"OK {path.name}")
    print(f"  paragraphs={len(doc.paragraphs)} tables={len(tables)} headings={len(headings)}")
    print(f"  first heading: {headings[0]!r}")
    print(f"  last heading : {headings[-1]!r}")
    print(f"  size={path.stat().st_size} bytes")


if __name__ == "__main__":
    output = build()
    verify(output)

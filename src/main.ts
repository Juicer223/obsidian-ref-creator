import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab, // ✅ 新增：用于创建设置面板
  Setting,          // ✅ 新增：用于创建设置项
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";

// ✅ 1. 定义设置数据的结构
interface RefCreatorSettings {
  refRootDir: string;
}

// ✅ 2. 默认设置
const DEFAULT_SETTINGS: RefCreatorSettings = {
  refRootDir: "_REF",
};

export default class RefLinkCreatorPlugin extends Plugin {
  settings: RefCreatorSettings; // 保存当前设置

  async onload() {
    // 加载设置
    await this.loadSettings();

    // 🌟 核心魔法：注册设置面板！加上这一句，你的插件就会出现在左侧边栏了！
    this.addSettingTab(new RefCreatorSettingTab(this.app, this));

    // 命令 1：在光标位置插入链接 + 创建 REF 文件
    this.addCommand({
      id: "insert-ref-link-and-create-note",
      name: "Insert REF link (insert at cursor, per-note folder, create note)",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const marker = `%%REF_LINK_MARKER_${Date.now()}%%`;
        editor.replaceSelection(marker);

        const cleanupMarker = () => {
          const content = editor.getValue();
          const idx = content.indexOf(marker);
          if (idx !== -1) {
            editor.replaceRange("", editor.offsetToPos(idx), editor.offsetToPos(idx + marker.length));
          }
        };

        try {
          const activeFile = view.file;
          if (!activeFile) {
            cleanupMarker();
            new Notice("No active note.");
            return;
          }

          const safeNoteFolderName = sanitizeFileBaseName(activeFile.basename);
          if (!safeNoteFolderName) {
            cleanupMarker();
            new Notice("Active note name is invalid for folder name.");
            return;
          }

          const input = await promptForText(this.app, "Link text", "Enter link text");
          
          if (!input || !input.trim()) {
            cleanupMarker();
            return;
          }

          const title = input.trim();
          const safeBaseName = sanitizeFileBaseName(title);
          if (!safeBaseName) {
            cleanupMarker();
            new Notice("Invalid link text (cannot create a valid file name).");
            return;
          }

          // ✅ 使用设置里的目录名称，而不是写死的字符串
          const rootDir = this.settings.refRootDir;
          const folderPath = normalizePath(`${rootDir}/${safeNoteFolderName}`);
          const filePath = normalizePath(`${rootDir}/${safeNoteFolderName}/${safeBaseName}.md`);

          await ensureFolder(this.app, folderPath);

          const file = await ensureFile(this.app, filePath, `# ${title}\n`);
          if (!file) {
            cleanupMarker();
            new Notice("Failed to create or find the target file.");
            return;
          }

          const mdLink = `[${escapeLinkText(title)}](<${rootDir}/${safeNoteFolderName}/${safeBaseName}.md>)`;

          const contentAfter = editor.getValue();
          const markerIndex = contentAfter.indexOf(marker);

          if (markerIndex !== -1) {
            const startPos = editor.offsetToPos(markerIndex);
            const endPos = editor.offsetToPos(markerIndex + marker.length);
            
            editor.replaceRange(mdLink, startPos, endPos);
            editor.focus();
            editor.setCursor(editor.offsetToPos(markerIndex + mdLink.length));
          } else {
            editor.focus();
            editor.replaceSelection(mdLink);
          }

          new Notice(`Inserted and created: ${filePath}`);
        } catch (err: any) {
          cleanupMarker();
          console.error("[REF Link Creator] insert command failed:", err);
          new Notice(`Insert REF link failed: ${err?.message ?? String(err)}`);
        }
      },
    });

    // 命令 2：清理未引用的 REF 文件
    this.addCommand({
      id: "clean-unused-ref-notes-in-current-note",
      name: "Clean unused REF notes (current note)",
      callback: async () => {
        try {
          const activeFile = this.app.workspace.getActiveFile();
          if (!activeFile) {
            new Notice("No active note.");
            return;
          }

          const noteName = sanitizeFileBaseName(activeFile.basename);
          if (!noteName) {
            new Notice("Active note name invalid for REF folder.");
            return;
          }

          const rootDir = this.settings.refRootDir;
          const folderPath = normalizePath(`${rootDir}/${noteName}`);
          const folderAbs = this.app.vault.getAbstractFileByPath(folderPath);

          if (!folderAbs) {
            new Notice(`No REF folder to clean: ${folderPath}`);
            return;
          }
          if (!(folderAbs instanceof TFolder)) {
            new Notice(`${folderPath} is not a folder.`);
            return;
          }

          const content = await this.app.vault.read(activeFile);

          const mdFiles = folderAbs.children.filter(
            (f): f is TFile => f instanceof TFile && f.extension === "md"
          );

          let deleted = 0;
          for (const f of mdFiles) {
            const base = f.basename;
            // 传递根目录名称给检测函数
            if (!isRefFileReferenced(content, noteName, base, rootDir)) {
              await trashFileRespectingSettings(this.app, f);
              deleted++;
            }
          }

          const folderAbs2 = this.app.vault.getAbstractFileByPath(folderPath);
          if (folderAbs2 instanceof TFolder && folderAbs2.children.length === 0) {
            await this.app.vault.delete(folderAbs2, true);
          }

          new Notice(`Clean done. Deleted ${deleted} unused REF notes.`);
        } catch (err: any) {
          console.error("[REF Link Creator] clean command failed:", err);
          new Notice(`Clean failed: ${err?.message ?? String(err)}`);
        }
      },
    });
  }

  // ✅ 读取设置
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  // ✅ 保存设置
  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ============================================================================
// ✅ 3. 设置面板类（这就是让你插件出现在左侧边栏的本体）
// ============================================================================
class RefCreatorSettingTab extends PluginSettingTab {
  plugin: RefLinkCreatorPlugin;

  constructor(app: App, plugin: RefLinkCreatorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 添加一个设置项：让用户自定义 REF 文件夹名
    new Setting(containerEl)
      .setName("Reference Folder Name")
      .setDesc("Set the root directory name where all references will be created (default is _REF).")
      .addText((text) =>
        text
          .setPlaceholder("Enter folder name, e.g., _REF")
          .setValue(this.plugin.settings.refRootDir)
          .onChange(async (value) => {
            // 当用户修改文本框时，实时保存设置
            this.plugin.settings.refRootDir = value.trim() || "_REF";
            await this.plugin.saveSettings();
          })
      );
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 弹窗输入 */
function promptForText(app: App, title: string, placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new InputModal(app, title, placeholder ?? "", (value) => resolve(value));
    modal.open();
  });
}

class InputModal extends Modal {
  private onSubmit: (value: string | null) => void;
  private titleText: string;
  private placeholder: string;

  constructor(app: App, titleText: string, placeholder: string, onSubmit: (value: string | null) => void) {
    super(app);
    this.onSubmit = onSubmit;
    this.titleText = titleText;
    this.placeholder = placeholder;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: this.titleText });

    const input = contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: this.placeholder },
    });
    input.style.width = "100%";
    input.focus();

    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });

    const okBtn = btnRow.createEl("button", { text: "OK" });
    okBtn.addEventListener("click", () => {
      const v = input.value ?? "";
      this.close();
      this.onSubmit(v);
    });

    const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.close();
      this.onSubmit(null);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") okBtn.click();
      if (e.key === "Escape") cancelBtn.click();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/** 确保目录存在（逐级创建） */
async function ensureFolder(app: App, folderPath: string) {
  const existing = app.vault.getAbstractFileByPath(folderPath);
  if (existing) return;

  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const p of parts) {
    current = current ? `${current}/${p}` : p;
    const abs = app.vault.getAbstractFileByPath(current);
    if (!abs) await app.vault.createFolder(current);
  }
}

/** 确保文件存在 */
async function ensureFile(app: App, filePath: string, defaultContent: string): Promise<TFile | null> {
  const existing = app.vault.getAbstractFileByPath(filePath);
  if (existing && existing instanceof TFile) return existing;

  try {
    return await app.vault.create(filePath, defaultContent);
  } catch (e) {
    const again = app.vault.getAbstractFileByPath(filePath);
    if (again && again instanceof TFile) return again;
    console.error(e);
    return null;
  }
}

/** 删除：遵循 Obsidian 的 Trash 设置 */
async function trashFileRespectingSettings(app: App, file: TFile) {
  // @ts-ignore
  if (app.fileManager?.trashFile) {
    // @ts-ignore
    await app.fileManager.trashFile(file);
    return;
  }

  // fallback
  // @ts-ignore
  if (typeof app.vault.trash === "function") {
    // @ts-ignore
    await app.vault.trash(file, true);
  } else {
    await app.vault.delete(file, true);
  }
}

/** 引用检测：支持 markdown link + wikilink */
function isRefFileReferenced(content: string, noteFolder: string, baseName: string, rootDir: string): boolean {
  const targets = [
    `${rootDir}/${noteFolder}/${baseName}.md`,
    `./${rootDir}/${noteFolder}/${baseName}.md`,
    `${rootDir}/${noteFolder}/${baseName}`,
    `./${rootDir}/${noteFolder}/${baseName}`,
  ].map(escapeRegExp);

  const mdLinkRe = new RegExp(
    String.raw`\[[^\]]*\]\(\s*<?(?:${targets.join("|")})>?\s*\)`,
    "u"
  );

  const wikiTarget = escapeRegExp(`${rootDir}/${noteFolder}/${baseName}`);
  const wikiRe = new RegExp(
    String.raw`\[\[\s*(?:${wikiTarget})(?:\.md)?(?:\|[^\]]+)?\s*\]\]`,
    "u"
  );

  return mdLinkRe.test(content) || wikiRe.test(content);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 清理非法文件名字符 */
function sanitizeFileBaseName(name: string): string {
  let s = name.trim();
  s = s.replace(/[\/\\]/g, "／");
  s = s.replace(/[<>:"|?*\u0000-\u001F]/g, " ");
  s = s.replace(/[\. ]+$/g, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** 链接文字转义 */
function escapeLinkText(text: string): string {
  return text.replace(/\]/g, "\\]");
}
import { Notice, PluginSettingTab, Setting, TextAreaComponent, TextComponent } from "obsidian";
import type { App } from "obsidian";
import { createCustomProfile, getActivePromptProfile, getProfilesForWorkflow } from "./prompts";
import type { PromptWorkflow, ProviderKind } from "./types";
import type { LingoNestPlugin } from "./main";

const providerLabels: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  groq: "Groq",
  fireworks: "Fireworks",
  "openai-compatible": "Custom OpenAI-compatible",
  ollama: "Ollama"
};

export class LingoNestSettingTab extends PluginSettingTab {
  plugin: LingoNestPlugin;

  constructor(app: App, plugin: LingoNestPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "LingoNest" });

    containerEl.createEl("h3", { text: "Provider" });
    new Setting(containerEl)
      .setName("Active provider")
      .setDesc("The same provider/model is used for chat, capture extraction, and review generation.")
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(providerLabels)) {
          dropdown.addOption(value, label);
        }
        dropdown.setValue(this.plugin.store.settings.provider.activeProvider);
        dropdown.onChange(async (value) => {
          await this.plugin.store.updateSettings((settings) => {
            const currentProvider = settings.provider.activeProvider;
            settings.provider.savedModels[currentProvider] = this.rememberModel(
              settings.provider.savedModels[currentProvider],
              settings.provider.model
            );
            settings.provider.activeProvider = value as typeof settings.provider.activeProvider;
            settings.provider.model = settings.provider.savedModels[settings.provider.activeProvider][0] || "";
          });
          this.plugin.notifyStateChanged();
          this.display();
        });
      });

    this.renderModelSetting(containerEl);

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Lower values are steadier; higher values are more varied.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.step = "0.1";
        text.setValue(String(this.plugin.store.settings.provider.temperature));
        text.onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isNaN(parsed)) {
            return;
          }
          await this.plugin.store.updateSettings((settings) => {
            settings.provider.temperature = parsed;
          });
          this.plugin.notifyStateChanged();
        });
      });

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Used for Ollama and custom OpenAI-compatible servers. Leave blank for hosted provider defaults.")
      .addText((text) => {
        text.setPlaceholder("http://127.0.0.1:11434 or https://host/v1");
        text.setValue(this.plugin.store.settings.provider.baseUrl);
        text.onChange(async (value) => {
          await this.plugin.store.updateSettings((settings) => {
            settings.provider.baseUrl = value.trim();
          });
          this.plugin.notifyStateChanged();
        });
      });

    new Setting(containerEl)
      .setName("Request timeout (ms)")
      .setDesc("Applies to provider calls.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.setValue(String(this.plugin.store.settings.provider.requestTimeoutMs));
        text.onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isNaN(parsed)) {
            return;
          }
          await this.plugin.store.updateSettings((settings) => {
            settings.provider.requestTimeoutMs = parsed;
          });
          this.plugin.notifyStateChanged();
        });
      });

    containerEl.createEl("h3", { text: "API Keys" });
    containerEl.createEl("p", {
      cls: "lingonest-settings-help",
      text: "Saved keys stay in this plugin's local data.json and are preserved across reinstalls. Environment variables still override them. Supported names: OPENAI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, FIREWORKS_API_KEY, OPENAI_COMPATIBLE_API_KEY."
    });
    this.renderSecretSetting(containerEl, "OpenAI API key", "openAIApiKey");
    this.renderSecretSetting(containerEl, "Anthropic API key", "anthropicApiKey");
    this.renderSecretSetting(containerEl, "Groq API key", "groqApiKey");
    this.renderSecretSetting(containerEl, "Fireworks API key", "fireworksApiKey");
    this.renderSecretSetting(containerEl, "OpenAI-compatible API key", "openAICompatibleApiKey");

    containerEl.createEl("h3", { text: "Plugin Behavior" });
    new Setting(containerEl)
      .setName("Vault root")
      .setDesc("Markdown notes are stored under this folder.")
      .addText((text) => {
        text.setValue(this.plugin.store.settings.vaultRoot);
        text.onChange(async (value) => {
          await this.plugin.store.updateSettings((settings) => {
            settings.vaultRoot = value.trim() || "LingoNest/Items";
          });
          this.plugin.notifyStateChanged();
        });
      });

    new Setting(containerEl)
      .setName("Default explanation language")
      .setDesc("Used when prompts need to know what language explanations should be written in.")
      .addText((text) => {
        text.setValue(this.plugin.store.settings.defaultExplanationLanguage);
        text.onChange(async (value) => {
          await this.plugin.store.updateSettings((settings) => {
            settings.defaultExplanationLanguage = value.trim() || "English";
          });
          this.plugin.notifyStateChanged();
        });
      });

    new Setting(containerEl)
      .setName("Auto-save capture")
      .setDesc("Automatically saves the primary learnable item from each chat exchange.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.store.settings.autoSave);
        toggle.onChange(async (value) => {
          await this.plugin.store.updateSettings((settings) => {
            settings.autoSave = value;
          });
          this.plugin.notifyStateChanged();
        });
      });

    new Setting(containerEl)
      .setName("UI font size")
      .setDesc("Scales only LingoNest. 14 is the default size.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = "11";
        text.inputEl.max = "22";
        text.inputEl.step = "1";
        text.setValue(String(this.plugin.store.settings.uiFontSize));
        text.onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isNaN(parsed)) {
            return;
          }
          const clamped = Math.max(11, Math.min(22, Math.round(parsed)));
          await this.plugin.store.updateSettings((settings) => {
            settings.uiFontSize = clamped;
          });
          this.plugin.notifyStateChanged();
        });
      });

    containerEl.createEl("h3", { text: "Prompt Profiles" });
    this.renderWorkflowEditor(containerEl, "chat");
    this.renderWorkflowEditor(containerEl, "capture");
    this.renderWorkflowEditor(containerEl, "review");
  }

  private renderSecretSetting(
    containerEl: HTMLElement,
    label: string,
    key:
      | "openAIApiKey"
      | "anthropicApiKey"
      | "groqApiKey"
      | "fireworksApiKey"
      | "openAICompatibleApiKey"
  ): void {
    new Setting(containerEl)
      .setName(label)
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.store.settings.provider[key]);
        text.onChange(async (value) => {
          await this.plugin.store.updateSettings((settings) => {
            settings.provider[key] = value.trim();
          });
        });
      });
  }

  private renderModelSetting(containerEl: HTMLElement): void {
    const activeProvider = this.plugin.store.settings.provider.activeProvider;
    const savedModels = this.getSavedModelsForProvider(activeProvider);
    let selectedSavedModel =
      savedModels.find((model) => model === this.plugin.store.settings.provider.model.trim()) ?? savedModels[0] ?? "";

    const setting = new Setting(containerEl)
      .setName("Model")
      .setDesc("Type a model ID, then apply it. LingoNest remembers models per provider so you can reuse or delete them later.");

    let modelInput: TextComponent | null = null;
    setting.addText((text) => {
      modelInput = text;
      text.setPlaceholder("Model ID");
      text.setValue(this.plugin.store.settings.provider.model);
      text.onChange(async (value) => {
        await this.plugin.store.updateSettings((settings) => {
          settings.provider.model = value.trim();
        });
        this.plugin.notifyStateChanged();
      });
      const commitTypedModel = async () => {
        const typedModel = text.inputEl.value.trim();
        if (!typedModel) {
          return;
        }
        await this.rememberCurrentModel(activeProvider, typedModel);
      };
      text.inputEl.addEventListener("blur", () => {
        void commitTypedModel();
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          void commitTypedModel();
        }
      });
    }).addButton((button) => {
      button.setButtonText("Apply");
      button.onClick(async () => {
        const typedModel = modelInput?.inputEl.value.trim() ?? "";
        if (!typedModel) {
          new Notice("Type a model ID first.");
          return;
        }
        await this.rememberCurrentModel(activeProvider, typedModel);
        new Notice(`Using model: ${typedModel}`);
        this.display();
      });
    });

    new Setting(containerEl)
      .setName("Saved models")
      .setDesc(
        savedModels.length
          ? `Previously used ${providerLabels[activeProvider]} models.`
          : "No saved models yet. Type one above, then press Enter or click outside the field."
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", savedModels.length ? "Choose a saved model..." : "No saved models yet");
        for (const model of savedModels) {
          dropdown.addOption(model, model);
        }
        const currentModel = this.plugin.store.settings.provider.model.trim();
        dropdown.setValue(savedModels.includes(currentModel) ? currentModel : "");
        dropdown.setDisabled(savedModels.length === 0);
        dropdown.onChange(async (value) => {
          selectedSavedModel = value.trim();
          const nextModel = value.trim();
          if (!nextModel) {
            return;
          }
          await this.rememberCurrentModel(activeProvider, nextModel);
          this.display();
        });
      })
      .addButton((button) => {
        button.setButtonText("Delete");
        button.onClick(async () => {
          const modelToDelete = selectedSavedModel || modelInput?.inputEl.value.trim() || "";
          if (!modelToDelete) {
            new Notice("Select a saved model to delete.");
            return;
          }
          await this.deleteSavedModel(activeProvider, modelToDelete);
          new Notice(`Deleted saved model: ${modelToDelete}`);
          this.display();
        });
      });
  }

  private renderWorkflowEditor(containerEl: HTMLElement, workflow: PromptWorkflow): void {
    const wrapper = containerEl.createDiv({ cls: "lingonest-settings-workflow" });
    wrapper.createEl("h4", { text: workflow.charAt(0).toUpperCase() + workflow.slice(1) });

    const profiles = getProfilesForWorkflow(this.plugin.store.settings.prompts.profiles, workflow);
    const active = getActivePromptProfile(
      this.plugin.store.settings.prompts.profiles,
      workflow,
      this.plugin.store.settings.prompts.activeProfileIds[workflow]
    );

    new Setting(wrapper)
      .setName("Active profile")
      .setDesc("Choose which system prompt to use for this workflow.")
      .addDropdown((dropdown) => {
        for (const profile of profiles) {
          dropdown.addOption(profile.id, profile.name);
        }
        dropdown.setValue(active.id);
        dropdown.onChange(async (value) => {
          await this.plugin.store.updateSettings((settings) => {
            settings.prompts.activeProfileIds[workflow] = value;
          });
          this.plugin.notifyStateChanged();
          this.display();
        });
      })
      .addButton((button) => {
        button.setButtonText("Duplicate");
        button.onClick(async () => {
          const next = createCustomProfile(workflow, active);
          await this.plugin.store.updateSettings((settings) => {
            settings.prompts.profiles.push(next);
            settings.prompts.activeProfileIds[workflow] = next.id;
          });
          this.plugin.notifyStateChanged();
          this.display();
        });
      });

    const nameSetting = new Setting(wrapper).setName("Profile name");
    const promptSetting = new Setting(wrapper).setName("System prompt");

    const nameInput = new TextComponent(nameSetting.controlEl);
    nameInput.setValue(active.name);
    nameInput.setDisabled(active.isBuiltIn);
    nameInput.onChange(async (value) => {
      await this.updateProfile(workflow, active.id, (profile) => {
        profile.name = value.trim() || "Custom";
      });
    });

    const textArea = new TextAreaComponent(promptSetting.controlEl);
    textArea.setValue(active.systemPrompt);
    textArea.inputEl.rows = 12;
    textArea.inputEl.addClass("lingonest-prompt-textarea");
    textArea.setDisabled(active.isBuiltIn);
    textArea.onChange(async (value) => {
      await this.updateProfile(workflow, active.id, (profile) => {
        profile.systemPrompt = value;
      });
    });

    const actions = wrapper.createDiv({ cls: "lingonest-settings-actions" });
    actions.createSpan({
      text: active.isBuiltIn
        ? "Built-in profiles cannot be deleted. Duplicate to customize."
        : "Custom profile"
    });
    const deleteButton = actions.createEl("button", { text: "Delete" });
    deleteButton.disabled = active.isBuiltIn;
    deleteButton.addEventListener("click", async () => {
      if (active.isBuiltIn) {
        new Notice("Built-in profiles cannot be deleted.");
        return;
      }
      await this.plugin.store.updateSettings((settings) => {
        settings.prompts.profiles = settings.prompts.profiles.filter((profile) => profile.id !== active.id);
        settings.prompts.activeProfileIds[workflow] = getProfilesForWorkflow(settings.prompts.profiles, workflow)[0]?.id ?? "";
      });
      this.plugin.notifyStateChanged();
      this.display();
    });
  }

  private async updateProfile(
    workflow: PromptWorkflow,
    profileId: string,
    mutator: (profile: { name: string; systemPrompt: string }) => void
  ): Promise<void> {
    await this.plugin.store.updateSettings((settings) => {
      const profile = settings.prompts.profiles.find((candidate) => candidate.workflow === workflow && candidate.id === profileId);
      if (!profile || profile.isBuiltIn) {
        return;
      }
      mutator(profile);
    });
    this.plugin.notifyStateChanged();
  }

  private getSavedModelsForProvider(provider: ProviderKind): string[] {
    const saved = [...(this.plugin.store.settings.provider.savedModels[provider] ?? [])];
    const currentModel = this.plugin.store.settings.provider.model.trim();
    if (provider === this.plugin.store.settings.provider.activeProvider && currentModel) {
      return this.rememberModel(saved, currentModel);
    }
    return saved;
  }

  private rememberModel(existing: string[], candidate: string): string[] {
    const model = candidate.trim();
    if (!model) {
      return existing;
    }
    return [model, ...existing.filter((entry) => entry !== model)].slice(0, 25);
  }

  private async rememberCurrentModel(provider: ProviderKind, model: string): Promise<void> {
    await this.plugin.store.updateSettings((settings) => {
      settings.provider.model = model.trim();
      settings.provider.savedModels[provider] = this.rememberModel(settings.provider.savedModels[provider], model);
    });
    this.plugin.notifyStateChanged();
  }

  private async deleteSavedModel(provider: ProviderKind, model: string): Promise<void> {
    const trimmed = model.trim();
    if (!trimmed) {
      return;
    }

    await this.plugin.store.updateSettings((settings) => {
      settings.provider.savedModels[provider] = settings.provider.savedModels[provider].filter((entry) => entry !== trimmed);
      if (settings.provider.activeProvider === provider && settings.provider.model.trim() === trimmed) {
        settings.provider.model = settings.provider.savedModels[provider][0] || "";
      }
    });
    this.plugin.notifyStateChanged();
  }
}

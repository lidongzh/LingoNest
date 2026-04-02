import type { LingoNestPlugin } from "../main";

export type LingoNestSection = "chat" | "items" | "review";

export function renderSectionNav(
  container: HTMLElement,
  plugin: LingoNestPlugin,
  activeSection: LingoNestSection
): void {
  const shell = container.createDiv({ cls: "lingonest-shell-bar" });
  const brand = shell.createDiv({ cls: "lingonest-shell-brand" });
  brand.createDiv({ cls: "lingonest-shell-title", text: "LingoNest" });
  brand.createDiv({ cls: "lingonest-shell-subtitle", text: describeSection(activeSection) });

  const nav = shell.createDiv({ cls: "lingonest-section-nav" });
  const sections: Array<{
    id: LingoNestSection;
    label: string;
    open: () => Promise<void>;
  }> = [
    {
      id: "chat",
      label: "Chat",
      open: async () => plugin.activateChatView()
    },
    {
      id: "items",
      label: "Items",
      open: async () => plugin.activateItemBrowserView()
    },
    {
      id: "review",
      label: "Review",
      open: async () => plugin.activateReviewView()
    }
  ];

  for (const section of sections) {
    const button = nav.createEl("button", {
      cls: `lingonest-section-nav-button${section.id === activeSection ? " is-active" : ""}`,
      text: section.label
    });
    button.addEventListener("click", () => {
      void section.open();
    });
  }
}

function describeSection(section: LingoNestSection): string {
  switch (section) {
    case "chat":
      return "Look up terms, refine meaning, and save study items.";
    case "items":
      return "Browse saved responses and manage your learning library.";
    case "review":
      return "Run a spaced review session and strengthen recall.";
  }
}

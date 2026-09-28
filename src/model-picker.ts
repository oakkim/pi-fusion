import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, SelectList, truncateToWidth, type SelectItem, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Shared model picker; custom terminal components are unavailable over RPC. */
export async function selectModel(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  currentValue?: string,
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  if (ctx.mode !== "tui") {
    const label = await ctx.ui.select(title, items.map((item) => item.label));
    return items.find((item) => item.label === label)?.value;
  }
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const input = new Input({ prompt: "Search: ", placeholder: "model or provider" });
    let filtered = items;
    let visibleRows = 0;
    let list: SelectList;
    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("muted", text),
    };
    const rebuild = (selected?: string) => {
      // Reserve header, search, spacing, scroll indicator, help, and overlay margins.
      visibleRows = Math.max(1, tui.terminal.rows - 8);
      list = new SelectList(filtered, visibleRows, listTheme);
      list.setSelectedIndex(Math.max(0, filtered.findIndex((item) => item.value === selected)));
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
    };
    rebuild(currentValue);

    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      invalidate() { input.invalidate(); list.invalidate(); },
      render(width: number) {
        if (visibleRows !== Math.max(1, tui.terminal.rows - 8)) rebuild(list.getSelectedItem()?.value);
        return [
          truncateToWidth(theme.fg("accent", title), width),
          ...input.render(width),
          "",
          ...(filtered.length ? list.render(width) : [theme.fg("muted", "No matching models")]),
          "",
          truncateToWidth(theme.fg("dim", "Type to search · ↑↓ / PgUp PgDn · Enter select · Esc cancel"), width),
        ];
      },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown")) {
          const index = filtered.findIndex((item) => item.value === list.getSelectedItem()?.value);
          list.setSelectedIndex(index + (keys.matches(data, "tui.select.pageUp") ? -visibleRows : visibleRows));
        } else if ((["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((key) => keys.matches(data, key))) {
          list.handleInput(data);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== before) {
            filtered = fuzzyFilter(items, input.getValue(), (item) => `${item.value} ${item.label} ${item.description ?? ""}`);
            rebuild();
          }
        }
        tui.requestRender();
      },
      handleMouse(event: TuiMouseEvent) {
        if (event.type === "wheel" || event.y >= 3) return list.handleMouse({ ...event, y: event.y - 3 });
        if (event.y === 1) return input.handleMouse({ ...event, y: 0 });
        return undefined;
      },
    };
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
}

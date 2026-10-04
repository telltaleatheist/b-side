/**
 * Copy text. The async clipboard API needs a secure context (the desktop window,
 * localhost, the iOS app); a browser tab on a LAN address is plain http, where
 * only the old selection copy works.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard !== undefined && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.readOnly = true;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

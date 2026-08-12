(function attachPlatform(root) {
  const desktop = root.dmDashDesktop;

  async function saveTextFile(filename, content, mimeType) {
    if (desktop && typeof desktop.saveCampaign === 'function') {
      return desktop.saveCampaign({ filename, content, mimeType });
    }
    const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.click();
      return { canceled: false, path: '' };
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  async function openTextFile(browserFile) {
    if (desktop && typeof desktop.openCampaign === 'function') return desktop.openCampaign();
    if (!browserFile) return { canceled: true, content: '' };
    if (browserFile.size > root.DMDashSecurity.MAX_IMPORT_BYTES) throw new Error('Campaign file exceeds the import limit.');
    return { canceled: false, content: await browserFile.text(), name: browserFile.name };
  }

  root.DMDashPlatform = Object.freeze({
    kind: desktop ? 'electron' : 'web',
    isDesktop: Boolean(desktop),
    openTextFile,
    saveTextFile
  });
})(window);

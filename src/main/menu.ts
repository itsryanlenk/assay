/**
 * The native application menu.
 *
 * Two reasons it exists beyond "apps have menus". First, the paste boxes in the
 * confirmation step are textareas the operator pastes a whole view-source into,
 * and a real Edit menu with the standard roles is what makes Cut/Copy/Paste/
 * Select-All behave the way muscle memory expects. Second, a Help menu is the
 * conventional place a user looks first, so it is the front door to the in-app
 * Help view and the About box.
 *
 * The Help items do not carry help TEXT here; they switch the window to the
 * Help view, which is the single source of that content. Duplicating it into a
 * dialog would be a second copy to keep in step, which this codebase avoids on
 * principle.
 */

import { app, BrowserWindow, Menu, MenuItemConstructorOptions, dialog } from 'electron';
import { CH } from '../shared/channels';

const isMac = process.platform === 'darwin';

/** Ask the window to show a view. Main telling its own renderer which tab to show. */
function navigate(win: BrowserWindow, view: string): void {
  if (!win.isDestroyed()) win.webContents.send(CH.menuNavigate, view);
}

function showAbout(win: BrowserWindow): void {
  void dialog.showMessageBox(win, {
    type: 'info',
    title: 'About Assay',
    message: `Assay  ·  v${app.getVersion()}`,
    detail:
      'A local-first outreach scanner for one operator. It finds a local business, ' +
      'checks its own page source, and drafts a packet. It never sends anything.\n\n' +
      'The one promise: every claim in a deliverable can be reproduced by the ' +
      'recipient with Ctrl+U. Findings stay REMOTE until you confirm them against ' +
      'your own view-source, and approval is per item.\n\n' +
      'Open Help for the full guide and the five laws.',
    buttons: ['Open Help', 'Close'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }).then((r) => {
    if (r.response === 0) navigate(win, 'help');
  });
}

export function buildAppMenu(win: BrowserWindow, opts: { isDev: boolean }): Menu {
  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { label: 'About Assay', click: () => showAbout(win) },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [isMac ? { role: 'close' } : { role: 'quit' }],
  });

  // The one that matters for the paste boxes: standard editing on the textareas.
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      // Devtools is a debugging surface; only offer it in dev so a packaged
      // build does not advertise a way to poke at the untrusted renderer.
      ...(opts.isDev ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []),
    ],
  });

  template.push({
    role: 'help',
    submenu: [
      // Distinct destinations: the second lands scrolled to the laws panel.
      // Two menu items opening the same scroll position read as a bug.
      { label: 'How Assay works', click: () => navigate(win, 'help') },
      { label: 'The five laws', click: () => navigate(win, 'help#laws') },
      { label: 'Settings and keys', click: () => navigate(win, 'settings') },
      { type: 'separator' },
      { label: 'About Assay', click: () => showAbout(win) },
    ],
  });

  return Menu.buildFromTemplate(template);
}

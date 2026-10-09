// Desktop alerts: the quickest way to put something in front of the operator. Fire and forget;
// the notification feed is the record, a toast is only the tap on the shoulder.

import { spawn } from "node:child_process";

export type ToastFn = (title: string, body: string) => void;

// Windows: a toast from Windows PowerShell 5.1 (WinRT), under an "Ogdoad" app id registered per
// user. Title and body travel in environment variables, so nothing in them is ever parsed as code.
const WINDOWS_TOAST = `
$ErrorActionPreference = 'Stop'
$id = 'Ogdoad'
$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $id
if (-not (Test-Path $key)) {
  New-Item -Path $key -Force | Out-Null
  New-ItemProperty -Path $key -Name DisplayName -Value 'Ogdoad' -PropertyType String -Force | Out-Null
}
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:OGDOAD_TOAST_TITLE)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode($env:OGDOAD_TOAST_BODY)) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

function run(file: string, args: string[], env?: Record<string, string>): void {
  try {
    const child = spawn(file, args, { stdio: "ignore", windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no desktop to alert; the feed still has it
  }
}

/** The desktop toast for this platform, or null where there isn't one. */
export function desktopToast(): ToastFn | null {
  if (process.platform === "win32") {
    const encoded = Buffer.from(WINDOWS_TOAST, "utf16le").toString("base64");
    return (title, body) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { OGDOAD_TOAST_TITLE: title, OGDOAD_TOAST_BODY: body });
  }
  if (process.platform === "darwin") {
    return (title, body) => run("osascript", ["-e", "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run", title, body]);
  }
  return (title, body) => run("notify-send", ["--app-name=Ogdoad", title, body]);
}

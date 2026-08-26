Dim fso, sh, folder, psPath, starterPath, command, exitCode
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
psPath = "C:\Program Files\PowerShell\7\pwsh.exe"
If Not fso.FileExists(psPath) Then psPath = "pwsh.exe"
starterPath = fso.BuildPath(folder, "start-dashboard-complete.ps1")

sh.CurrentDirectory = folder
command = Chr(34) & psPath & Chr(34) & " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " & Chr(34) & starterPath & Chr(34)
exitCode = sh.Run(command, 0, True)
If exitCode <> 0 Then
  sh.Popup "Usage Watch startup check failed. Check the local service and phone display ports, then try again.", 0, "Usage Watch", 16
End If

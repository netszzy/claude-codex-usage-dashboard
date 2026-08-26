Dim fso, sh, folder, cmdPath, starterPath, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
cmdPath = sh.ExpandEnvironmentStrings("%ComSpec%")
starterPath = fso.BuildPath(folder, "start-dashboard-desktop.bat")

sh.CurrentDirectory = folder
command = Chr(34) & cmdPath & Chr(34) & " /d /c " & Chr(34) & Chr(34) & starterPath & Chr(34) & Chr(34)
sh.Run command, 0, False

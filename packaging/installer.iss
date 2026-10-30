; Inno Setup recipe for NyenzEdit-Setup.exe. Build with:  iscc /DMyVersion=1.10.0 packaging\installer.iss
; It installs for the current user only, so Windows does not ask for an administrator password.
; The AppId never changes: a new version installs over the old one (also over the versions called EditForge).
#ifndef MyVersion
  #define MyVersion "0.0.0"
#endif
#define MyApp "Nyenz Edit"
#define MyExe "NyenzEdit.exe"
#define MyUrl "https://github.com/nyenz/nyenz-video-edit"

[Setup]
AppId={{6E2C1B4A-5D2B-4C69-9E57-ED17F0F0A1B5}
AppName={#MyApp}
AppVersion={#MyVersion}
AppVerName={#MyApp} {#MyVersion}
AppPublisher=Nyenz
AppPublisherURL={#MyUrl}
AppSupportURL={#MyUrl}/issues
AppUpdatesURL={#MyUrl}/releases/latest
AppCopyright=MIT License
AppContact={#MyUrl}
DefaultDirName={localappdata}\Programs\Nyenz Edit
DefaultGroupName={#MyApp}
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=NyenzEdit-Setup
; the icon of the installer file, of the uninstaller, and of the entry in Settings > Apps
SetupIconFile=nyenz-edit.ico
UninstallDisplayIcon={app}\{#MyExe},0
UninstallDisplayName={#MyApp}
WizardImageFile=wizard-100.bmp,wizard-200.bmp
WizardSmallImageFile=wizard-small-100.bmp,wizard-small-200.bmp
WizardStyle=modern
VersionInfoCompany=Nyenz
VersionInfoDescription={#MyApp} installer
VersionInfoProductName={#MyApp}
VersionInfoProductVersion={#MyVersion}
VersionInfoVersion={#MyVersion}
VersionInfoCopyright=MIT License
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
ShowLanguageDialog=no

[Tasks]
Name: "desktopicon"; Description: "Put a Nyenz Edit icon on the desktop"; GroupDescription: "Icons:"

[InstallDelete]
; the icons were called "EditForge" before 1.5.0
Type: files; Name: "{autoprograms}\EditForge.lnk"
Type: files; Name: "{autodesktop}\EditForge.lnk"

[Files]
Source: "..\dist\NyenzEdit\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "nyenz-edit.ico"; DestDir: "{app}"; Flags: ignoreversion
; the program was called EditForge.exe before 1.8.1: a button pinned to the taskbar back then still points there, so an
; existing EditForge.exe is replaced by the new program (same files, old name) instead of being left behind broken
Source: "..\dist\NyenzEdit\{#MyExe}"; DestDir: "{app}"; DestName: "EditForge.exe"; Flags: ignoreversion onlyifdestfileexists

[Icons]
; AppUserModelID matches the app window (editforge/taskbar.py), so the window and a pinned button use the Nyenz Edit icon
Name: "{autoprograms}\{#MyApp}"; Filename: "{app}\{#MyExe}"; IconFilename: "{app}\nyenz-edit.ico"; Comment: "Edit videos on this computer"; AppUserModelID: "NyenzEdit.App"
Name: "{autodesktop}\{#MyApp}"; Filename: "{app}\{#MyExe}"; IconFilename: "{app}\nyenz-edit.ico"; Tasks: desktopicon; Comment: "Edit videos on this computer"; AppUserModelID: "NyenzEdit.App"

[Run]
Filename: "{app}\{#MyExe}"; Description: "Open Nyenz Edit now"; Flags: nowait postinstall skipifsilent
; after an automatic update (the app runs the installer with /SILENT /RELAUNCH) open the app again
Filename: "{app}\{#MyExe}"; Flags: nowait runasoriginaluser; Check: Relaunch

[Code]
function Relaunch(): Boolean;
begin
  Result := WizardSilent() and (Pos('/RELAUNCH', Uppercase(GetCmdTail())) > 0);
end;

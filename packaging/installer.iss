; Inno Setup recipe for NyenzEdit-Setup.exe. Build with:  iscc /DMyVersion=1.14.0 packaging\installer.iss
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
// The AI models (sound splitting, captions) are downloaded here, once, with a size and SHA-256 check, so nothing is downloaded
// later. The list comes from editforge/modelpack.py (tools/make_models_iss.py writes models.iss). A model that is already in
// place (an update) is not downloaded again. If a download fails, Nyenz Edit still installs and fetches the model when it is first used.
#include "models.iss"

var
  ModelPage: TDownloadWizardPage;

function Relaunch(): Boolean;
begin
  Result := WizardSilent() and (Pos('/RELAUNCH', Uppercase(GetCmdTail())) > 0);
end;

function ModelHome(): String;
begin
  Result := ExpandConstant('{%USERPROFILE}\.editforge\');
end;

function ModelPresent(I: Integer): Boolean;
var
  Path: String;
begin
  Path := ModelHome() + ModelDest(I);
  Result := FileExists(Path) and (CompareText(GetSHA256OfFile(Path), ModelSha(I)) = 0);
end;

function OnModelProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure InitializeWizard();
begin
  ModelPage := CreateDownloadPage('Getting the AI models', 'Sound splitting and captions need these. They are downloaded once now, so nothing is downloaded later.', @OnModelProgress);
  ModelPage.ShowBaseNameInsteadOfUrl := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  I: Integer;
  Need: Boolean;
begin
  Result := True;
  if CurPageID <> wpReady then
    Exit;
  ModelPage.Clear;
  Need := False;
  for I := 0 to ModelCount() - 1 do
    if not ModelPresent(I) then
    begin
      ModelPage.Add(ModelUrl(I), ModelTempName(I), ModelSha(I));
      Need := True;
    end;
  if not Need then
    Exit;
  ModelPage.Show;
  try
    try
      ModelPage.Download;
    except
      Log('Model download did not finish: ' + GetExceptionMessage);
      if not ModelPage.AbortedByUser then
        SuppressibleMsgBox('The AI models could not be downloaded now (' + GetExceptionMessage + '). Nyenz Edit is still installed. It downloads them the first time you use sound splitting or captions (that needs the internet then).', mbInformation, MB_OK, IDOK);
    end;
  finally
    ModelPage.Hide;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  I: Integer;
  Temp, Dest: String;
begin
  if (CurStep = ssInstall) and WizardSilent() then
  begin
    { an automatic update has no download page: get the models that are missing now (an earlier version did not have them) }
    for I := 0 to ModelCount() - 1 do
      if not ModelPresent(I) then
      begin
        try
          DownloadTemporaryFile(ModelUrl(I), ModelTempName(I), ModelSha(I), nil);
        except
          Log('Model download did not finish: ' + GetExceptionMessage);
        end;
      end;
  end;
  if CurStep <> ssPostInstall then
    Exit;
  for I := 0 to ModelCount() - 1 do
  begin
    Temp := ExpandConstant('{tmp}\') + ModelTempName(I);
    Dest := ModelHome() + ModelDest(I);
    if FileExists(Temp) then
    begin
      ForceDirectories(ExtractFilePath(Dest));
      if FileCopy(Temp, Dest, False) then
        DeleteFile(Temp)
      else
        Log('Could not copy the model to ' + Dest);
    end;
  end;
end;

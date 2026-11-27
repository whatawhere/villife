#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6E1E2C4A-6F9B-4E3E-9C1B-8F2A5D7C3E11}
AppName=Villife
AppVersion={#AppVersion}
AppPublisher=Villife
AppPublisherURL=https://github.com/whatawhere/villife
AppSupportURL=https://github.com/whatawhere/villife/issues
DefaultDirName={autopf}\Villife
DefaultGroupName=Villife
DisableProgramGroupPage=yes
OutputBaseFilename=VillifeSetup
OutputDir=..\..\release-out
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Villife.exe
SetupIconFile=villife.ico
CloseApplications=yes
RestartApplications=no

[Files]
Source: "..\..\Villife.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\Villife.exe.config"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\villife.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\src\*"; DestDir: "{app}\src"; Flags: ignoreversion recursesubdirs
Source: "..\..\webview2\*"; DestDir: "{app}\webview2"; Flags: ignoreversion recursesubdirs
Source: "..\..\WebView2RuntimeInstaller.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{autoprograms}\Villife"; Filename: "{app}\Villife.exe"

[Run]
Filename: "{tmp}\WebView2RuntimeInstaller.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2 Runtime..."; Flags: waituntilterminated; Check: not WebView2Installed
Filename: "{app}\Villife.exe"; Description: "Start Villife"; Flags: nowait postinstall skipifsilent

[Code]
function WebView2Installed(): Boolean;
var
  Version: string;
begin
  Result := False;
  if RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
    Result := Version <> '';
  if not Result then
    if RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', Version) then
      Result := Version <> '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    if not WebView2Installed then
      WizardForm.StatusLabel.Caption := 'Finishing...';
  end;
end;

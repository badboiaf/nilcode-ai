; NULLCODE Windows installer (Inno Setup)
; Builds dist/NULLCODE-Setup-x64.exe from the SEA executable.

#define AppName "NULLCODE"
#define AppVersion RemoveQuotes(GetEnv("NC_VERSION"))
#if AppVersion == ""
#define AppVersion "0.1.0"
#endif
#define AppPublisher "XEER0"
#define AppExe "NULLCODE.exe"

[Setup]
AppId={{8E1C0E2A-6C7B-4F62-9A44-NULLCODE0001}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=NULLCODE-Setup-x64-{#AppVersion}
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExe}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\dist\NULLCODE\NULLCODE.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dist\NULLCODE\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{localappdata}\NULLCODE"; Permissions: users-modify

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; User data in {localappdata}\NULLCODE is intentionally preserved on uninstall.
Type: filesandordirs; Name: "{app}"

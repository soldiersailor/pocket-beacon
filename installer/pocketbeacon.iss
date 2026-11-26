; Inno Setup скрипт установщика Pocket Beacon.
; Собирается через scripts/build-installer.ps1 (npm run build:installer),
; который готовит build\staging\ и передаёт версию параметром /DAppVersion.

#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif

[Setup]
AppId={{A63E8F2B-4C1D-4E7A-9B3F-2D5C8E1F6A90}
AppName=Pocket Beacon
AppVersion={#AppVersion}
AppPublisher=Pocket Beacon contributors
AppSupportURL=https://github.com/soldiersailor/pocket-beacon
DefaultDirName={localappdata}\Programs\PocketBeacon
DefaultGroupName=Pocket Beacon
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\build
OutputBaseFilename=PocketBeacon-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Pocket Beacon

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; GroupDescription: "Дополнительно:"

[Files]
Source: "..\build\staging\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Pocket Beacon"; Filename: "{app}\Pocket Beacon.bat"
Name: "{group}\Удалить Pocket Beacon"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Pocket Beacon"; Filename: "{app}\Pocket Beacon.bat"; Tasks: desktopicon

[Run]
Filename: "{app}\Pocket Beacon.bat"; Description: "Запустить Pocket Beacon"; Flags: postinstall skipifsilent shellexec

[UninstallDelete]
; Удаляем всё, включая созданные в рантайме данные (БД, .env, логи, сертификаты)
Type: filesandordirs; Name: "{app}"

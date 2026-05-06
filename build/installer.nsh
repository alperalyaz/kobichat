; electron-builder NSIS — kurulum / kaldırma sonrası güvenlik duvarı
; https://www.electron.build/configuration/nsis

!macro customInstall
  DetailPrint "Güvenlik duvarı: KobiChat (TCP 3847) kuralı uygulanıyor..."
  ; Aynı isimli eski kural varsa sil
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="KobiChat TCP 3847" 2>nul'
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="LAN Sohbet TCP 3847" 2>nul'
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="KobiChat UDP 3850" 2>nul'
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="LAN Sohbet UDP 3850" 2>nul'
  ; HTTP/Socket.IO + UDP keşif
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall add rule name="KobiChat TCP 3847" dir=in action=allow protocol=TCP localport=3847'
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall add rule name="KobiChat UDP 3850" dir=in action=allow protocol=UDP localport=3850'
  DetailPrint "Tamamlandı (yönetici izni yoksa kural eklenmemiş olabilir)."
!macroend

!macro customUnInstall
  DetailPrint "Güvenlik duvarı kuralı kaldırılıyor..."
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="KobiChat TCP 3847"'
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="KobiChat UDP 3850"'
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="LAN Sohbet TCP 3847"'
  nsExec::ExecToLog 'cmd /c netsh advfirewall firewall delete rule name="LAN Sohbet UDP 3850"'
!macroend

# Warface App (Switchboard for Windows)

<p align="center">
  <img src="src/ui/app-icon.png" width="128" height="128" alt="Warface App Icon" />
</p>

<p align="center">
  <strong>One quiet window for WhatsApp, Slack, Telegram and more — natively built for Windows.</strong>
  <br />
  <em>Una sola ventana sin distracciones para WhatsApp, Slack, Telegram y más — adaptado nativamente para Windows.</em>
</p>

<p align="center">
  <a href="#english">English</a> • <a href="#español">Español</a> • <a href="#downloads--descargas">Downloads / Descargas</a> • <a href="#development--desarrollo">Development / Desarrollo</a>
</p>

---

## Downloads / Descargas

| File / Archivo | Type / Tipo | Description / Descripción |
| :--- | :--- | :--- |
| [**Switchboard Setup 0.2.4.exe**](dist/Switchboard%20Setup%200.2.4.exe) | Installer / Instalador | Standard Windows setup with Desktop & Start Menu shortcuts. / Instalador estándar para Windows con accesos directos. |
| [**Switchboard 0.2.4.exe**](dist/Switchboard%200.2.4.exe) | Portable / Portable | Standalone single-file binary. Double-click and run, no install required. / Ejecutable único sin instalación. |

---

<a name="english"></a>
## 🇬🇧 English

### Overview
**Warface App (Switchboard for Windows)** is an ultra-clean, privacy-focused all-in-one messaging client designed to bring **WhatsApp, Slack, Telegram, Discord, Google Messages, Messenger** and more into a single, unified workspace on Windows.

Originally conceived as Switchboard for macOS, this project is ported to Windows with full native OS integration, custom performance management, and zero telemetry.

### Key Features
* **Isolated Persistent Sessions (`WebContentsView`):** Each chat service runs in its own sandboxed partition (`persist:service_id`). Your cookies, tokens, and active logins are completely isolated and never mixed.
* **Intelligent RAM Optimization:**
  * **Memory Trim:** Clears page caches after 2 minutes of a tab being in the background.
  * **Background Sleep:** Suspends inactive heavy services after 10 minutes of inactivity to keep memory usage minimal.
* **Native Windows Integration:**
  * **Modern Titlebar Overlay:** Windows minimize, maximize, and close controls seamlessly blend into the top bar, adapting dynamically to Windows Light and Dark themes.
  * **System Tray Resident:** Minimizes cleanly to the Windows taskbar tray beside the system clock. Closing the window keeps background notifications alive.
  * **Taskbar Overlay Badge:** Unread message counts are displayed directly over the Windows taskbar icon.
  * **Custom In-App Banners:** Floating toast notifications displayed in the corner of your active monitor.
* **100% Private:** No proxy servers, no third-party accounts, no telemetry or trackers. Everything communicates directly from your machine to the respective service.

### Keyboard Shortcuts
* <kbd>Ctrl</kbd> + <kbd>N</kbd>: Add a new service
* <kbd>Ctrl</kbd> + <kbd>1</kbd> ... <kbd>9</kbd>: Switch directly to service 1 through 9
* <kbd>Ctrl</kbd> + <kbd>Tab</kbd>: Next service
* <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd>: Previous service
* <kbd>Ctrl</kbd> + <kbd>R</kbd>: Reload active service
* <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>: Hard reload (clear cache)
* <kbd>Ctrl</kbd> + <kbd>0</kbd> / <kbd>+</kbd> / <kbd>-</kbd>: Reset / Zoom In / Zoom Out
* <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd>: Open DevTools for current service

---

<a name="español"></a>
## 🇪🇸 Español

### Descripción General
**Warface App (Switchboard for Windows)** es un cliente de mensajería unificado, ultra ligero y centrado en la privacidad, diseñado para integrar **WhatsApp, Slack, Telegram, Discord, Google Messages, Messenger** y más en una sola ventana sin distracciones en Windows.

Basado en el diseño original de Switchboard para macOS, esta versión fue portada a Windows con integración nativa al sistema operativo, gestión avanzada de memoria y cero analíticas.

### Características Principales
* **Sesiones Aisladas y Seguras (`WebContentsView`):** Cada servicio se ejecuta en una partición web aislada (`persist:service_id`). Tus credenciales, cookies y sesiones no interfieren entre sí.
* **Gestión Inteligente de Memoria RAM:**
  * **Liberación de Caché (Trim):** Vacía la memoria de páginas inactivas tras 2 minutos en segundo plano.
  * **Suspensión Automática (Sleep):** Pone en reposo servicios pesados después de 10 minutos de inactividad para evitar el consumo excesivo de RAM.
* **Integración Nativa con Windows:**
  * **Barra de Título Moderna (`titleBarOverlay`):** Botones de minimizar, maximizar y cerrar perfectamente acoplados en la barra superior de 44px, compatibles con el modo claro y oscuro de Windows.
  * **Bandeja del Sistema (System Tray):** Permanece activo junto al reloj al cerrar la ventana para seguir recibiendo notificaciones sin saturar la barra de tareas. Menú contextual para restaurar, saltar a un chat o salir.
  * **Badge en Barra de Tareas:** Indicador visual de mensajes no leídos sobre el icono de la barra de tareas.
  * **Banners Flotantes:** Notificaciones elegantes en la esquina superior de la pantalla.
* **Privacidad Total:** Sin servidores intermedios, sin cuentas de terceros ni telemetría. Tu computadora se conecta directamente a cada plataforma oficial.

### Atajos de Teclado
* <kbd>Ctrl</kbd> + <kbd>N</kbd>: Añadir un nuevo servicio
* <kbd>Ctrl</kbd> + <kbd>1</kbd> ... <kbd>9</kbd>: Cambiar rápidamente a los servicios 1 al 9
* <kbd>Ctrl</kbd> + <kbd>Tab</kbd>: Siguiente servicio
* <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd>: Servicio anterior
* <kbd>Ctrl</kbd> + <kbd>R</kbd>: Recargar servicio activo
* <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd>: Recargar forzando borrado de caché
* <kbd>Ctrl</kbd> + <kbd>0</kbd> / <kbd>+</kbd> / <kbd>-</kbd>: Zoom estándar / Aumentar / Disminuir
* <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd>: Herramientas de desarrollo (DevTools)

---

<a name="development--desarrollo"></a>
## 🛠️ Development & Build / Desarrollo y Compilación

### Prerequisites / Requisitos
* [Node.js](https://nodejs.org/) (v20 o superior recomendado)
* npm

### Installation & Run / Instalación y Ejecución
```bash
# Clone the repository / Clonar el repositorio
git clone https://github.com/pedrodevpy/warfaceapp.git
cd warfaceapp

# Install dependencies / Instalar dependencias
npm install

# Run in development mode / Iniciar en modo desarrollo
npm start
```

### Packaging / Empaquetado para Windows
```bash
# Build unpacked application / Generar versión descomprimida
npm run pack

# Build NSIS installer and portable EXE / Compilar instalador NSIS y versión portable
npm run dist
```
Los ejecutables se generarán en la carpeta `dist/`.

---

## 📄 License & Acknowledgments / Licencia y Agradecimientos
* Basado en el concepto original de **Switchboard** por David Diaz ([switchboard-releases](https://github.com/davdiazd/switchboard-releases)).
* Distribuido bajo licencia MIT / ISC.

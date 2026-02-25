# Riftbound Duel Emulator

A high-fidelity rules-based emulator for the **Riftbound** card game. Built with React and TypeScript, this tool provides a comprehensive environment for simulating 1v1 duels, testing card interactions, and refining game strategies.

## 🚀 Tech Stack

- **Framework:** [React 19](https://react.dev/)
- **Build Tool:** [Vite](https://vitejs.dev/)
- **Language:** [TypeScript](https://www.typescriptlang.org/)
- **Styling:** CSS3
- **Test Framework:** [Playwright](https://playwright.dev/)

## 🛠️ Project Structure

The project has been organized for clarity and ease of development:

```text
.
├── .vscode/                # VS Code workspace settings
├── public/                 # Static assets (images, icons)
├── src/                    # Core application source
│   ├── main.tsx            # Application entry point
│   ├── App.tsx             # Root component
│   ├── Logic.tsx           # Rules engine and game logic
│   └── index.css           # Global styles
├── Rules/                  # Game rules documentation
├── RB TSX Critical Run Files/ # Backup of original source files
├── index.html              # HTML template
├── package.json            # Dependencies and scripts
├── tsconfig.json           # TypeScript configuration
├── vite.config.ts          # Vite build configuration
└── riftbound_data_expert (1).json # Game data source
```

## 🎮 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)

### Installation

1. Clone the repository to your local machine.
2. Install dependencies:
   ```bash
   npm install
   ```

### Development

Run the development server:
```bash
npm run dev
```
The application will be available at `http://localhost:5173`.

### Testing

Run the automated test suite:
```bash
npm run test:target-ui
```

## 📜 Core Logic Overview

The emulator implements a robust rules-based core that handles:
- **Setup & Mulligan:** Automatic legend/champion assignment and up to 2 recyclings.
- **Turn Structure:** Full lifecycle management from Awaken to Ending phases.
- **Combat System:** Rules-aligned showdowns and combat resolution.
- **Rune Management:** Rune deck/pool cycling and energy/power calculations.
- **Effect Engine:** A lightweight resolver for most common game verbs and templated effects.

## ⚖️ License

This project is intended for development and simulation purposes.

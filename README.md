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

- `src/`: Core application source code.
  - `Logic.tsx`: The heart of the emulator, containing the comprehensive rules engine and game logic.
  - `App.tsx`: Main entry component.
  - `main.tsx`: Application bootstrap.
- `public/`: Static assets and public resources.
- `Rules/`: Reference documentation for game rules and mechanics.
- `RB TSX Critical Run Files/`: Original project source (preserved for backup).
- `riftbound_data_expert.json`: The source-of-truth JSON file containing card data, stats, and ability logic.

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

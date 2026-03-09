import './styles/main.css';
import { initApp, addRemoteFiles, addLocalFiles } from './app.js';

// Initialize the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

// Export functions for external use
export { addRemoteFiles, addLocalFiles };

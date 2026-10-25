/**
 * InputManager: Captures keyboard movement, mouse aiming/clicking, and gameplay hotkeys.
 */
export class InputManager {
  /**
   * @param {object} callbacks
   * @param {Function} callbacks.onDirectionChange
   * @param {Function} callbacks.onAction
   */
  constructor({ onDirectionChange, onAction }) {
    this.onDirectionChange = onDirectionChange;
    this.onAction = onAction;

    this.keys = new Set();
    this.currentVector = { x: 0, y: 0 };
    this.mousePos = { x: 0, y: 0 };

    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._onMouseMove = this._handleMouseMove.bind(this);
    this._onMouseDown = this._handleMouseDown.bind(this);
    this._onBlur = this._handleBlur.bind(this);
  }

  start() {
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('blur', this._onBlur);
  }

  stop() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('blur', this._onBlur);
    this.reset();
  }

  reset() {
    this.keys.clear();
    this._updateDirection();
  }

  _isInputActive(target) {
    return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  }

  _handleKeyDown(event) {
    if (this._isInputActive(event.target)) return;

    const code = event.code;

    // Movement keys
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
      if (!this.keys.has(code)) {
        this.keys.add(code);
        this._updateDirection();
      }
      event.preventDefault();
      return;
    }

    // Action keys
    if (code === 'Space') {
      if (typeof this.onAction === 'function') {
        this.onAction({ type: 'HARVEST' });
      }
      event.preventDefault();
      return;
    }

    if (code === 'Digit1') {
      if (typeof this.onAction === 'function') {
        this.onAction({ type: 'TOGGLE_BUILD', structureType: 'wall' });
      }
      event.preventDefault();
      return;
    }

    if (code === 'Digit2') {
      if (typeof this.onAction === 'function') {
        this.onAction({ type: 'TOGGLE_BUILD', structureType: 'campfire' });
      }
      event.preventDefault();
      return;
    }

    if (code === 'Digit3') {
      if (typeof this.onAction === 'function') {
        this.onAction({ type: 'TOGGLE_BUILD', structureType: 'turret' });
      }
      event.preventDefault();
      return;
    }

    if (code === 'KeyF') {
      if (typeof this.onAction === 'function') {
        this.onAction({ type: 'EAT' });
      }
      event.preventDefault();
      return;
    }

    if (code === 'Escape') {
      if (typeof this.onAction === 'function') {
        this.onAction({ type: 'CANCEL_BUILD' });
      }
      event.preventDefault();
      return;
    }
  }

  _handleKeyUp(event) {
    if (this._isInputActive(event.target)) return;

    const code = event.code;
    if (this.keys.has(code)) {
      this.keys.delete(code);
      this._updateDirection();
      event.preventDefault();
    }
  }

  _handleMouseMove(event) {
    this.mousePos.x = event.clientX;
    this.mousePos.y = event.clientY;
  }

  _handleMouseDown(event) {
    if (this._isInputActive(event.target)) return;

    // Check if clicked directly on UI elements (ignore if clicked on HUD button)
    if (event.target && event.target.closest('.hud-widget')) {
      return;
    }

    if (event.button === 0) { // Left click
      if (typeof this.onAction === 'function') {
        this.onAction({
          type: 'CLICK',
          screenX: event.clientX,
          screenY: event.clientY,
        });
      }
    }
  }

  _handleBlur() {
    this.reset();
  }

  _updateDirection() {
    let rawX = 0;
    let rawY = 0;

    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) rawX -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) rawX += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) rawY -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) rawY += 1;

    let dirX = 0;
    let dirY = 0;

    const len = Math.hypot(rawX, rawY);
    if (len > 0) {
      dirX = Math.round((rawX / len) * 1000) / 1000;
      dirY = Math.round((rawY / len) * 1000) / 1000;
    }

    if (dirX !== this.currentVector.x || dirY !== this.currentVector.y) {
      this.currentVector = { x: dirX, y: dirY };
      if (typeof this.onDirectionChange === 'function') {
        this.onDirectionChange(this.currentVector);
      }
    }
  }

  getMousePosition() {
    return this.mousePos;
  }
}

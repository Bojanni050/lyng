import React from 'react';
import { localized } from 'mailspring-exports';
import {
  AIModelInfo,
  describePricing,
  formatContextLength,
} from '../../../../src/ai/provider-catalog';

const MAX_VISIBLE_ROWS = 80;

type ModelPickerProps = {
  models: AIModelInfo[];
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
};

type ModelPickerState = {
  open: boolean;
  query: string;
  activeIndex: number;
};

/**
 * Dropdown for the model catalogue. A native `<select>` can only render one line per option,
 * and providers return a description, a price and capability tags per model, so this renders
 * a searchable list instead. 177 models from DeepInfra are unusable without the filter.
 */
export default class ModelPicker extends React.Component<ModelPickerProps, ModelPickerState> {
  static displayName = 'ModelPicker';

  state: ModelPickerState = { open: false, query: '', activeIndex: 0 };

  private _container: HTMLDivElement;
  private _search: HTMLInputElement;

  componentDidMount() {
    document.addEventListener('mousedown', this._onDocumentMouseDown);
  }

  componentWillUnmount() {
    document.removeEventListener('mousedown', this._onDocumentMouseDown);
  }

  componentDidUpdate(prevProps: ModelPickerProps, prevState: ModelPickerState) {
    if (this.state.open && !prevState.open && this._search) {
      this._search.focus();
    }
    if (this.state.open && this.state.activeIndex !== prevState.activeIndex) {
      this._scrollActiveIntoView();
    }
    if (prevProps.models !== this.props.models && this.state.open) {
      this.setState({ activeIndex: 0 });
    }
  }

  _onDocumentMouseDown = (event: MouseEvent) => {
    if (!this.state.open) return;
    const container = this._container;
    if (container && !container.contains(event.target as Node)) {
      this.setState({ open: false });
    }
  };

  _scrollActiveIntoView() {
    const list = this._container?.querySelector('.ai-model-list');
    const row = list?.querySelector(`[data-row-index="${this.state.activeIndex}"]`);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  _matchingModels(): AIModelInfo[] {
    const query = this.state.query.trim().toLowerCase();
    if (!query) return this.props.models;
    return this.props.models.filter((model) =>
      [model.name, model.id, model.description, model.capabilities.join(' ')]
        .filter(Boolean)
        .some((text) => (text as string).toLowerCase().includes(query))
    );
  }

  _select(model: AIModelInfo) {
    this.props.onChange(model.id);
    this.setState({ open: false, query: '', activeIndex: 0 });
  }

  _onKeyDown = (event: React.KeyboardEvent) => {
    const matches = this._matchingModels();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.setState({ open: false });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.setState({ activeIndex: Math.min(this.state.activeIndex + 1, matches.length - 1) });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.setState({ activeIndex: Math.max(this.state.activeIndex - 1, 0) });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const model = matches[this.state.activeIndex];
      if (model) this._select(model);
    }
  };

  _renderRow(model: AIModelInfo, index: number) {
    const pricing = describePricing(model);
    const context = formatContextLength(model.contextLength);
    const selected = model.id === this.props.value;
    const className = [
      'ai-model-row',
      index === this.state.activeIndex ? 'active' : '',
      selected ? 'selected' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div
        key={model.id}
        className={className}
        role="option"
        aria-selected={selected}
        data-row-index={index}
        onMouseEnter={() => this.setState({ activeIndex: index })}
        onClick={() => this._select(model)}
      >
        <div className="ai-model-row-head">
          <span className="ai-model-name">{model.name}</span>
          {model.deprecated ? (
            <span className="ai-model-chip ai-model-chip-warning">{localized('Deprecated')}</span>
          ) : null}
          {pricing ? <span className="ai-model-price">{pricing}</span> : null}
        </div>
        {model.description ? (
          <div className="ai-model-row-description">{model.description}</div>
        ) : null}
        <div className="ai-model-row-meta">
          {model.capabilities.map((capability) => (
            <span key={capability} className="ai-model-chip">
              {capability}
            </span>
          ))}
          {context ? <span className="ai-model-context">{context}</span> : null}
          {!pricing ? (
            <span className="ai-model-context">{localized('price not published')}</span>
          ) : null}
        </div>
      </div>
    );
  }

  render() {
    const { models, value, disabled } = this.props;
    const selected = models.find((model) => model.id === value);
    const matches = this._matchingModels();
    const visible = matches.slice(0, MAX_VISIBLE_ROWS);
    const hidden = matches.length - visible.length;
    const selectedPricing = selected ? describePricing(selected) : null;

    return (
      <div className="ai-model-picker" ref={(el) => (this._container = el)}>
        <button
          type="button"
          className="ai-model-picker-button"
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={this.state.open}
          onClick={() => this.setState({ open: !this.state.open, activeIndex: 0 })}
        >
          <span className="ai-model-picker-value">
            {selected ? selected.name : value || localized('Choose a model')}
          </span>
          <span className="ai-model-picker-hint">
            {selectedPricing || (disabled ? localized('Fetch models first') : '')}
          </span>
        </button>

        {this.state.open ? (
          <div className="ai-model-panel" onKeyDown={this._onKeyDown}>
            <input
              ref={(el) => (this._search = el)}
              className="ai-model-search"
              type="text"
              value={this.state.query}
              placeholder={localized('Search models by name, capability or description')}
              onChange={(e) => this.setState({ query: e.target.value, activeIndex: 0 })}
            />
            <div className="ai-model-list" role="listbox">
              {visible.map((model, index) => this._renderRow(model, index))}
              {visible.length === 0 ? (
                <div className="ai-model-empty">{localized('No models match this search.')}</div>
              ) : null}
              {hidden > 0 ? (
                <div className="ai-model-empty">
                  {localized(
                    '%@ more models match — keep typing to narrow the list.',
                    String(hidden)
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
}

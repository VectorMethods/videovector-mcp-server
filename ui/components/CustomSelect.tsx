import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTabActivity } from '../contexts/TabActivityContext';
import './CustomSelect.css';

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  ariaInvalid?: boolean;
}

const CustomSelect: React.FC<CustomSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = 'Select...',
  disabled = false,
  className = '',
  ariaLabel,
  ariaDescribedBy,
  ariaInvalid = false,
}) => {
  const { isActive } = useTabActivity();
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selectId = useId();
  const triggerId = `custom-select-trigger-${selectId}`;
  const menuId = `custom-select-menu-${selectId}`;

  // Get the label for current value
  const selectedOption = options.find(opt => opt.value === value);
  const displayText = selectedOption?.label || placeholder;

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen && isActive) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, isActive]);

  useEffect(() => {
    if (disabled) {
      setIsOpen(false);
    }
  }, [disabled]);

  // Handle keyboard navigation
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (disabled) return;

    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        setIsOpen(!isOpen);
        break;
      case 'ArrowDown':
        if (options.length === 0) break;
        if (!isOpen) {
          setIsOpen(true);
        } else {
          // Move to next option
          const currentIndex = options.findIndex(opt => opt.value === value);
          const nextIndex = Math.min(currentIndex + 1, options.length - 1);
          onChange(options[nextIndex].value);
        }
        event.preventDefault();
        break;
      case 'ArrowUp':
        if (options.length === 0) break;
        if (isOpen) {
          // Move to previous option
          const currentIndex = options.findIndex(opt => opt.value === value);
          const prevIndex = Math.max(currentIndex - 1, 0);
          onChange(options[prevIndex].value);
        }
        event.preventDefault();
        break;
    }
  };

  const handleOptionClick = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div
      ref={wrapperRef}
      className={`custom-select-wrapper ${className}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !isOpen) return;
        event.stopPropagation();
        setIsOpen(false);
        wrapperRef.current?.querySelector<HTMLButtonElement>('[role="combobox"]')?.focus();
      }}
    >
      <button
        id={triggerId}
        type="button"
        role="combobox"
        className={`custom-select-btn ${isOpen ? 'open' : ''}`}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-invalid={ariaInvalid || undefined}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={menuId}
      >
        <span className="select-text">{displayText}</span>
        <ChevronDown size={14} className="select-icon" />
      </button>

      <div
        id={menuId}
        className={`custom-select-menu ${isOpen ? 'open' : ''}`}
        role="listbox"
        aria-labelledby={triggerId}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`custom-select-option ${value === option.value ? 'selected' : ''}`}
            onClick={() => handleOptionClick(option.value)}
            role="option"
            aria-selected={value === option.value}
          >
            {option.description ? (
              <span className="custom-select-option-copy">
                <span>{option.label}</span>
                <span className="custom-select-option-description">{option.description}</span>
              </span>
            ) : option.label}
          </button>
        ))}
      </div>
    </div>
  );
};

export default CustomSelect;

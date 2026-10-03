/*---------------------------------------------------------------------------------------------
 *  Atelier: the small pieces the pages share -- icons, the model picker, the box a question is typed in.
 *--------------------------------------------------------------------------------------------*/

import { KeyboardEvent, ReactNode, useEffect, useRef } from 'react';
import { ModelInfo } from '../shared/api';

/** A codicon. */
export function Icon({ name, spin }: { name: string; spin?: boolean }) {
	return <i className={`codicon codicon-${name}${spin ? ' codicon-modifier-spin' : ''}`} aria-hidden="true" />;
}

export function ErrorLine({ error, onDismiss }: { error: string | undefined; onDismiss?: () => void }) {
	if (!error) {
		return null;
	}
	return (
		<div className="at-error" role="alert">
			<Icon name="error" />
			<span>{error}</span>
			{onDismiss && <button type="button" className="at-icon-btn" onClick={onDismiss} aria-label="Dismiss"><Icon name="close" /></button>}
		</div>
	);
}

export function ModelPicker({ models, value, onChange }: { models: readonly ModelInfo[]; value: string | undefined; onChange: (id: string) => void }) {
	return (
		<label className="at-model" title="The DataSuite AI model that plans, reads and writes">
			<Icon name="sparkle" />
			<select value={value ?? ''} onChange={e => onChange(e.target.value)} aria-label="AI model">
				{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
			</select>
		</label>
	);
}

/** A text box that grows with what is typed (to a point); Enter sends, Shift+Enter breaks the line. */
export function PromptBox({ value, onChange, onSubmit, placeholder, autoFocus, disabled }: {
	value: string; onChange: (value: string) => void; onSubmit: () => void; placeholder: string; autoFocus?: boolean; disabled?: boolean;
}) {
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const el = ref.current;
		if (el) {
			el.style.height = 'auto';
			el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
		}
	}, [value]);
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			onSubmit();
		}
	};
	return <textarea ref={ref} className="at-prompt" rows={1} value={value} placeholder={placeholder} autoFocus={autoFocus} disabled={disabled}
		onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown} />;
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
	return (
		<div className="at-empty">
			<Icon name={icon} />
			<h2>{title}</h2>
			{children}
		</div>
	);
}

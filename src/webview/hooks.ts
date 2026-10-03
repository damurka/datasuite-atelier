/*---------------------------------------------------------------------------------------------
 *  Atelier: hooks for the screens -- the host, data loaded from it (and reloaded on its events), errors.
 *--------------------------------------------------------------------------------------------*/

import { DependencyList, useCallback, useEffect, useRef, useState } from 'react';
import { AtelierEvents, AtelierHost } from '../shared/api';
import { hostProxy, onHostEvent } from './rpc';

export const host = hostProxy<AtelierHost>();

export interface Loaded<T> {
	readonly value: T | undefined;
	readonly error: string | undefined;
	readonly loading: boolean;
	reload(): void;
}

/** `load()`'s result, loaded again when `deps` change and when the host fires one of `events`. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList, events: (keyof AtelierEvents)[] = []): Loaded<T> {
	const [value, setValue] = useState<T>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(true);
	const generation = useRef(0);

	// eslint-disable-next-line react-hooks/exhaustive-deps
	const run = useCallback(() => {
		const mine = ++generation.current;
		setLoading(true);
		load().then(
			v => { if (mine === generation.current) { setValue(v); setError(undefined); setLoading(false); } },
			(e: Error) => { if (mine === generation.current) { setError(e.message); setLoading(false); } }
		);
	}, deps);

	useEffect(() => {
		run();
		const offs = events.map(name => onHostEvent<unknown>(name, run));
		return () => offs.forEach(off => off());
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [run]);

	return { value, error, loading, reload: run };
}

/** Runs an action, keeping its error to show (and whether it is running). */
export function useAction(): [(action: () => Promise<unknown>) => Promise<void>, string | undefined, boolean, () => void] {
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const run = useCallback(async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(undefined);
		try {
			await action();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);
	return [run, error, busy, () => setError(undefined)];
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "Today", "Yesterday", or the date in full. */
export function dayLabel(time: number): string {
	const date = new Date(time);
	const today = new Date();
	if (sameDay(date, today)) {
		return 'Today';
	}
	if (sameDay(date, new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1))) {
		return 'Yesterday';
	}
	return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export function timeLabel(time: number): string {
	return new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/*---------------------------------------------------------------------------------------------
 *  Atelier: the first page -- a question, the model to work with, and Synthesize.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { AppState } from '../../shared/api';
import { ErrorLine, Icon, ModelPicker, PromptBox } from '../components';
import { host, useAction } from '../hooks';

const EXAMPLES = [
	'What are the socioeconomic barriers to breast cancer screening in sub-Saharan Africa?',
	'Does kangaroo mother care reduce neonatal mortality in low birth weight infants?',
	'How effective are community health workers at improving childhood immunization coverage?'
];

export function Home({ state, model, setModel, open }: { state: AppState; model: string | undefined; setModel: (id: string) => void; open: (sessionId: string) => void }) {
	const [text, setText] = useState('');
	const [run, error, busy, dismiss] = useAction();
	const ask = (question: string) => {
		if (question.trim() && model && !busy) {
			void run(async () => open(await host.ask(undefined, question, model)));
		}
	};
	return (
		<div className="at-home">
			<div className="at-home__inner">
				<h1>Welcome to Atelier.</h1>
				<p className="at-home__lead">What shall we research today?</p>
				<div className="at-ask">
					<PromptBox value={text} onChange={setText} onSubmit={() => ask(text)} placeholder="Ask a question or synthesize research..." autoFocus disabled={busy} />
					<div className="at-ask__bar">
						<ModelPicker models={state.models} value={model} onChange={setModel} />
						<button type="button" className="at-btn at-btn--primary" disabled={!text.trim() || !model || busy} onClick={() => ask(text)}>
							<span>Synthesize</span><Icon name={busy ? 'loading' : 'arrow-right'} spin={busy} />
						</button>
					</div>
				</div>
				<ErrorLine error={error} onDismiss={dismiss} />
				<div className="at-examples">
					{EXAMPLES.map(example => <button key={example} type="button" className="at-example" onClick={() => setText(example)}><Icon name="lightbulb" /><span>{example}</span></button>)}
				</div>
				<p className="at-home__note">
					Atelier plans the searches, asks PubMed, Europe PMC, OpenAlex and Semantic Scholar, ranks what they return {state.embeddings.available ? 'by meaning with DataSuite\'s embeddings' : 'by keywords'}, reads the best papers and writes a cited summary.
					{!state.embeddings.available && state.embeddings.message ? ` ${state.embeddings.message}` : ''}
				</p>
			</div>
		</div>
	);
}

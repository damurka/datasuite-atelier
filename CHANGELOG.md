# Changelog

## 0.1.0

- The Atelier Meter: for a yes/no question, how the cited papers answer it (yes, possibly, mixed, no), each weighted
  by its evidence tier and citations; each paper shows what it says.
- A Paper Summary, written for the session's topic the first time a paper's details are opened, and kept.
- Filters over a query's papers (year, sample size, study design, what the paper says, open access, words) and sorting.
- Quality signals on papers: highly cited, high-impact journal, large sample, full text read, abstract may overstate.
- Candidates gain citation counts, open-access PDFs and the journal's citedness from OpenAlex before they are ranked.
- The open-access full text (Europe PMC) is read beside the abstract where a paper has one (`atelier.readFullText`).
- Ranking: 50 papers asked of each database instead of 20; closeness to the question is the embeddings' similarity
  blended with keywords; how cited the journal is counts in the score.
- Ranking puts relevance first: the AI rates every candidate against the question (title and abstract, 20 a request)
  and that rating, with closeness to the topic, decides the order; quality adds at most 10 points, between papers of
  like relevance. Papers rated off-topic are set aside without a full read.
- Papers that came without an abstract get one from PubMed or Europe PMC; one with only open-access full text is
  read from that.
- The ranking's keyword weight is fitted on what past screenings found relevant, once there are enough of them.
- Wider searches: several queries a database, each in different words; Crossref and CORE (open-access repositories:
  theses, reports, working papers) beside the four, arXiv on request; the citation trail of the best papers found
  (what they cite, what cites them, what Semantic Scholar finds similar); and a second search in other words when few
  papers answer the question. Databases are chosen in Settings.
- Faster searches: abstracts are read five to a request; a model can be set for screening and reading (a fast one,
  and the same from search to search); a first look at the answer is written from the top abstracts while the papers
  are read, and the papers that answer the question are listed as they are found.
- Thumbs up and down on a paper: the session's later searches are screened with those judgments, leave out what was
  judged out, and follow the citations of what was judged in.
- **Atelier: Run Ranking Benchmark**: questions with the DOIs they should bring back (`benchmark.json`), and a report
  of where each came in the ranking.
- Citation styles, chosen in Settings or the Download menu: Vancouver "(1-3, 5)", AMA raised numbers, IEEE
  "[1]-[3], [5]", APA 7th and Harvard "(Lee et al., 2021)". The PDF report cites in its text as the style does and
  ends with its references written out in the style; the formatted list of references follows it too.
- The evidence table's population, sample size and methods come from the paper's full text where it is open access:
  the PMCID is looked up for papers that came without one, the AI is given the methods and results sections first,
  and a paper read before from its abstract alone is read again. The table says which each row was read from.
- The PDF report's references are as they are selected on screen: the list or the table, those the filters leave, in
  the order they are sorted.
- The sidebar is a panel of all the sessions, with a search box, grouped by how long ago they were started.
- A Settings page in the app: the contact email and the databases' API keys, how wide a search goes, and deleting
  what is kept (a session, all sessions, everything). Deleting asks first.
- Ways in beside the Command Palette: Atelier's own view in the side bar (the sessions; Open Atelier, New Search and
  History in its title), a button in the status bar, and a walkthrough on the Welcome page.
- Download a query: the report as a PDF laid out as on screen (the window's font and colours, justified text), its
  tables as CSV, its papers with all extracted data as CSV, and its references as a formatted list, RIS or BibTeX.
- A follow-up's references are shown as a search's are: the papers its answer cites, as cards with their details.
- References are listed best evidence first -- how directly the paper answers the question on the AI's full read,
  then the strength of its study design (a meta-analysis before a cross-sectional study, however cited), then
  citations and journal -- and a paper's citation number is its place in that list. The
  synthesis is told to build on the lowest-numbered papers first.
- Reading goes down the ranking until 20 papers answer the question (or 60 have been read), instead of stopping at
  the first 20 whatever the screening left.
- Faster: the topic is embedded while the searches are planned; six papers are read at a time.

- Atelier as a DataSuite extension: the search pipeline of the Python app (query planning, PubMed, Europe PMC, OpenAlex
  and Semantic Scholar, ranking, screening and extraction, cited synthesis, follow-ups that chat or search again), with
  DataSuite's chat models and embeddings, and a React webview.

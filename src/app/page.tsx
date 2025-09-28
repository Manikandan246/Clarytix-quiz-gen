import TopicSplitForm from "@/components/TopicSplitForm";

export default function Home() {
  return (
    <div className="page">
      <main className="container">
        <header className="hero">
          <h1>Chapter Topic Splitter</h1>
          <p>
            Upload an entire book PDF, specify the chapter, and let OpenAI craft 6-10
            focused topics for you.
          </p>
        </header>
        <TopicSplitForm />
      </main>
    </div>
  );
}

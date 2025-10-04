import TopicSplitForm from "@/components/TopicSplitForm";

export default function Home() {
  return (
    <div className="page">
      <main className="container">
        <header className="hero">
      <h1>QFac</h1>
      <p>Clarytix&apos;s Proprietary Question Generator Model</p>
        </header>
        <TopicSplitForm />
      </main>
    </div>
  );
}

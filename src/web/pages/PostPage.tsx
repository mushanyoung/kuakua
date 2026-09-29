import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import { type PostDetail } from "../api";
import { PostCard } from "../components/PostCard";
import { Empty, Spinner } from "../components/ui";
import { errorText } from "../i18n";
import { Link, navigate } from "../router";
import { useApp, useApi } from "../state";

export function PostPage({ id }: { id: string }) {
  const { t } = useApp();
  const res = useApi<PostDetail>(`/api/posts/${id}`);
  return (
    <div className="page narrow">
      <Link to="/" className="back-link">
        <ArrowLeftIcon className="ic" /> {t("post.back")}
      </Link>
      {res.error && <Empty title={errorText(t, res.error)} />}
      {!res.data && !res.error && <Spinner label={t("loading")} />}
      {res.data && (
        <PostCard
          post={res.data.post}
          openComments
          onChange={(post) => res.setData({ ...res.data!, post })}
          onDeleted={() => navigate("/", { replace: true })}
        />
      )}
    </div>
  );
}

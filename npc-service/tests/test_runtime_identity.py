from src.runtime_identity import resolve_instance_id


def test_explicit_instance_id_wins():
    assert resolve_instance_id({"NPC_INSTANCE_ID": "local-1", "ECS_CONTAINER_METADATA_URI_V4": "http://x"}) == "local-1"


def test_ecs_task_id_comes_from_the_task_arn():
    def fetch(url):
        assert url == "http://169.254.170.2/v4/abc/task"
        return {"TaskARN": "arn:aws:ecs:us-east-1:123456789012:task/ewo-npc/0f1e2d3c4b5a"}

    env = {"ECS_CONTAINER_METADATA_URI_V4": "http://169.254.170.2/v4/abc"}
    assert resolve_instance_id(env, fetch_json=fetch) == "0f1e2d3c4b5a"


def test_unreadable_metadata_falls_back_to_the_hostname():
    def fetch(url):
        raise OSError("no route")

    assert resolve_instance_id({"ECS_CONTAINER_METADATA_URI_V4": "http://x"}, fetch_json=fetch)

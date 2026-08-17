# Minimal sshd for teleport ssh integration tests.
# testuser's password must stay in sync with PASSWORD in test/teleport/ssh.test.ts.
FROM alpine:3.22
RUN apk add --no-cache openssh \
  && ssh-keygen -A \
  && adduser -D -s /bin/sh testuser \
  && echo 'testuser:opencode-teleport-test-pw' | chpasswd \
  # sshd config is first-match-wins and alpine ships AllowTcpForwarding no;
  # drop any existing occurrences before appending ours
  && sed -i -E '/^#?[[:space:]]*(PasswordAuthentication|KbdInteractiveAuthentication|AllowTcpForwarding|PermitRootLogin)/d' /etc/ssh/sshd_config \
  && printf '%s\n' \
    'PasswordAuthentication yes' \
    'KbdInteractiveAuthentication no' \
    'AllowTcpForwarding yes' \
    'PermitRootLogin no' \
    >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
